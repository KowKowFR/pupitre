import 'server-only';
import { createHash } from 'node:crypto';
import { ssoDiscoveryUrl, type SsoSettings } from '@pupitre/core';
import { assertEgressAllowed } from '@pupitre/core/egress';
import { getAppSettings, getSsoClientSecret } from '@pupitre/db';
import { logger } from './logger';

/**
 * Single sign-on as the panel uses it, right now.
 *
 * Better Auth freezes its providers when its instance is built; single sign-on,
 * for its part, is set from the panel, live. This module therefore holds the
 * **effective** configuration on `globalThis` — with a fingerprint —, and
 * `getAuth()` rebuilds its instance when the fingerprint changes. On `globalThis`
 * and not in a module variable: Next can load several copies of this file, and
 * all of them must see the same configuration.
 *
 * The discovery is read here, **before** offering the button: Better Auth only
 * reads it at construction, and a provider unreachable at that moment is set
 * aside silently. Better to know it, say it on the settings screen, and not offer
 * a button that would lead to an error.
 */

export type SsoRuntime = {
  /** Changes as soon as a setting that matters changes: it is the rebuild key. */
  key: string;
  settings: SsoSettings;
  clientSecret: string;
};

/**
 * Why single sign-on is not offered. A code and its raw detail (an address, an
 * HTTP status): the sentence belongs to the screen, which says it in the
 * instance's language (`sso.problem.*`).
 */
export type SsoProblem = {
  code: 'missing' | 'http' | 'issuer' | 'incomplete' | 'unreachable' | 'unreadable';
  detail: string | null;
};

export type SsoState = {
  runtime: SsoRuntime | null;
  problem: SsoProblem | null;
  checkedAt: number;
};

declare global {
  var __pupitreSso: SsoState | undefined;
}

/** After a failure, we retry at most every minute — the sign-in screen does not wait. */
const RETRY_AFTER_MS = 60_000;
const DISCOVERY_TIMEOUT_MS = 5_000;

export function ssoState(): SsoState {
  return globalThis.__pupitreSso ?? { runtime: null, problem: null, checkedAt: 0 };
}

/** What the sign-in screen needs to know: nothing secret. */
export function ssoButton(): { label: string } | null {
  const runtime = ssoState().runtime;
  return runtime ? { label: runtime.settings.label } : null;
}

export type DiscoveryCheck =
  { ok: true; issuer: string; endpoints: string[] } | { ok: false; problem: SsoProblem };

/**
 * Does the provider answer, and does it say what it should? The announced issuer
 * must be the one that was typed: it is the one that signs the tokens, and Better
 * Auth will refuse any token signed by another.
 */
export async function checkDiscovery(issuer: string): Promise<DiscoveryCheck> {
  const url = ssoDiscoveryUrl(issuer);
  try {
    await assertEgressAllowed(url);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      return { ok: false, problem: { code: 'http', detail: `HTTP ${response.status} — ${url}` } };
    }
    const document = (await response.json()) as Record<string, unknown>;
    const announced = typeof document.issuer === 'string' ? document.issuer : null;
    if (announced?.replace(/\/+$/, '') !== issuer.replace(/\/+$/, '')) {
      return { ok: false, problem: { code: 'issuer', detail: announced ?? '?' } };
    }
    const required = ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const;
    const missing = required.filter((field) => typeof document[field] !== 'string');
    if (missing.length > 0) {
      return { ok: false, problem: { code: 'incomplete', detail: missing.join(', ') } };
    }
    return {
      ok: true,
      issuer: announced,
      endpoints: required.map((field) => String(document[field])),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, problem: { code: 'unreachable', detail: `${url} — ${message}` } };
  }
}

/**
 * Reads the configuration and the discovery again, and updates the shared state.
 * To call at startup and after each save of the settings.
 */
export async function refreshSso(): Promise<SsoState> {
  const now = Date.now();
  let state: SsoState;
  try {
    const { settings, ssoClientSecretConfigured } = await getAppSettings();
    const sso = settings.sso;
    if (!sso.enabled) {
      state = { runtime: null, problem: null, checkedAt: now };
    } else if (!sso.issuer || !sso.clientId || !ssoClientSecretConfigured) {
      state = { runtime: null, problem: { code: 'missing', detail: null }, checkedAt: now };
    } else {
      const discovery = await checkDiscovery(sso.issuer);
      if (!discovery.ok) {
        state = { runtime: null, problem: discovery.problem, checkedAt: now };
      } else {
        const clientSecret = (await getSsoClientSecret()) ?? '';
        const key = createHash('sha256')
          .update(
            JSON.stringify({
              sso,
              secret: createHash('sha256').update(clientSecret).digest('hex'),
            }),
          )
          .digest('hex');
        state = { runtime: { key, settings: sso, clientSecret }, problem: null, checkedAt: now };
      }
    }
  } catch (error) {
    logger.error({ err: error }, 'single sign-on: configuration unreadable');
    state = { runtime: null, problem: { code: 'unreadable', detail: null }, checkedAt: now };
  }
  if (state.problem) logger.warn({ problem: state.problem }, 'single sign-on unavailable');
  globalThis.__pupitreSso = state;
  return state;
}

/**
 * The state, read again if needed: enabled but unavailable (provider off when the
 * panel started), we retry — at most once a minute.
 */
export async function currentSso(): Promise<SsoState> {
  const state = ssoState();
  if (state.checkedAt === 0) return refreshSso();
  if (state.problem && Date.now() - state.checkedAt > RETRY_AFTER_MS) return refreshSso();
  return state;
}

// ─── the groups of a sign-in in progress ──────────────────────────────────────

/**
 * The provider's profile is only visible when Better Auth reads it
 * (`mapProfileToUser`); the roles, for their part, apply afterwards, when the
 * session exists. In between, within the same request, the groups wait here — a
 * few seconds at most, under the profile's email address.
 */
const PENDING_TTL_MS = 60_000;

declare global {
  var __pupitreSsoGroups: Map<string, { groups: string[]; at: number }> | undefined;
}

function pending(): Map<string, { groups: string[]; at: number }> {
  globalThis.__pupitreSsoGroups ??= new Map();
  return globalThis.__pupitreSsoGroups;
}

export function rememberSsoGroups(email: string, groups: string[]): void {
  const now = Date.now();
  for (const [key, entry] of pending()) if (now - entry.at > PENDING_TTL_MS) pending().delete(key);
  pending().set(email.toLowerCase(), { groups, at: now });
}

/** A sign-in's groups in progress, not consumed: the account's creation reads them too. */
export function peekSsoGroups(email: string): string[] | null {
  const entry = pending().get(email.toLowerCase());
  if (!entry || Date.now() - entry.at > PENDING_TTL_MS) return null;
  return entry.groups;
}

export function takeSsoGroups(email: string): string[] | null {
  const key = email.toLowerCase();
  const entry = pending().get(key);
  pending().delete(key);
  if (!entry || Date.now() - entry.at > PENDING_TTL_MS) return null;
  return entry.groups;
}
