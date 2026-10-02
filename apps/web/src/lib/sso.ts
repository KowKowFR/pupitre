import 'server-only';
import { createHash } from 'node:crypto';
import { ssoDiscoveryUrl, type SsoSettings } from '@pupitre/core';
import { assertEgressAllowed } from '@pupitre/core/egress';
import { getAppSettings, getSsoClientSecret } from '@pupitre/db';
import { logger } from './logger';

/**
 * La connexion unique telle que le panel s'en sert, à l'instant.
 *
 * Better Auth fige ses fournisseurs à la construction de son instance ; la
 * connexion unique, elle, se règle depuis le panel, à chaud. Ce module tient
 * donc la configuration **effective** sur `globalThis` — avec une empreinte —,
 * et `getAuth()` reconstruit son instance quand l'empreinte change. Sur
 * `globalThis` et non dans une variable de module : Next peut charger plusieurs
 * copies de ce fichier, et toutes doivent voir la même configuration.
 *
 * La découverte est lue ici, **avant** d'offrir le bouton : Better Auth ne la
 * lit qu'à la construction, et un fournisseur injoignable à ce moment-là est
 * écarté en silence. Mieux vaut le savoir, le dire sur l'écran de réglage, et
 * ne pas proposer un bouton qui mènerait à une erreur.
 */

export type SsoRuntime = {
  /** Change dès qu'un réglage qui compte change : c'est la clé de reconstruction. */
  key: string;
  settings: SsoSettings;
  clientSecret: string;
};

/**
 * Pourquoi la connexion unique n'est pas offerte. Un code et son détail brut
 * (une adresse, un statut HTTP) : la phrase appartient à l'écran, qui la dit
 * dans la langue de l'instance (`sso.problem.*`).
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

/** Après un échec, on retente au plus toutes les minutes — l'écran de connexion n'attend pas. */
const RETRY_AFTER_MS = 60_000;
const DISCOVERY_TIMEOUT_MS = 5_000;

export function ssoState(): SsoState {
  return globalThis.__pupitreSso ?? { runtime: null, problem: null, checkedAt: 0 };
}

/** Ce que l'écran de connexion a besoin de savoir : rien de secret. */
export function ssoButton(): { label: string } | null {
  const runtime = ssoState().runtime;
  return runtime ? { label: runtime.settings.label } : null;
}

export type DiscoveryCheck =
  { ok: true; issuer: string; endpoints: string[] } | { ok: false; problem: SsoProblem };

/**
 * Le fournisseur répond-il, et dit-il ce qu'il faut ? L'émetteur annoncé doit
 * être celui qu'on a saisi : c'est lui qui signe les jetons, et Better Auth
 * refusera tout jeton signé par un autre.
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
 * Relit la configuration et la découverte, et met à jour l'état partagé. À
 * appeler au démarrage et après chaque enregistrement des réglages.
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
    logger.error({ err: error }, 'connexion unique : configuration illisible');
    state = { runtime: null, problem: { code: 'unreadable', detail: null }, checkedAt: now };
  }
  if (state.problem) logger.warn({ problem: state.problem }, 'connexion unique indisponible');
  globalThis.__pupitreSso = state;
  return state;
}

/**
 * L'état, relu s'il le faut : activée mais indisponible (fournisseur éteint au
 * démarrage du panel), on retente — au plus une fois par minute.
 */
export async function currentSso(): Promise<SsoState> {
  const state = ssoState();
  if (state.checkedAt === 0) return refreshSso();
  if (state.problem && Date.now() - state.checkedAt > RETRY_AFTER_MS) return refreshSso();
  return state;
}

// ─── les groupes d'une connexion en cours ─────────────────────────────────────

/**
 * Le profil du fournisseur n'est visible qu'au moment où Better Auth le lit
 * (`mapProfileToUser`) ; les rôles, eux, s'appliquent après, quand la session
 * existe. Entre les deux, dans la même requête, les groupes attendent ici —
 * quelques secondes au plus, sous l'adresse e-mail du profil.
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

/** Les groupes d'une connexion en cours, sans les consommer : la création du compte les lit aussi. */
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
