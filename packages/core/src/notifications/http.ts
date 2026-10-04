import { assertEgressAllowed, EgressRefusedError } from '../egress.js';
import type { UiLanguage } from '../i18n.js';
import type { ChannelConfig, NotificationChannelKind } from './catalog.js';
import { NotificationError, describeFailure, redactSecrets, type FetchLike } from './types.js';

/**
 * HTTP call shared by the three channels that make one — Telegram, Discord,
 * webhook. Three times the same caution: a time bound, a truncated error body,
 * and **nothing** that looks like a token in the reported message.
 *
 * The `fetch` is received as an argument and not imported: that is what allows
 * checking a payload's shape without network.
 */

export type HttpCallOptions = {
  channel: NotificationChannelKind;
  fetch: FetchLike;
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  /** Values to mask in any reported error message. */
  secrets: ChannelConfig;
  /** The language of the reported errors — the instance's. */
  language?: UiLanguage;
};

export type HttpCallResult = { status: number; text: string };

export async function httpCall(options: HttpCallOptions): Promise<HttpCallResult> {
  const init: RequestInit = {
    method: options.method,
    headers: {
      accept: 'application/json',
      'user-agent': 'pupitre/notifications',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    signal: AbortSignal.timeout(options.timeoutMs),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  };

  // A webhook never targets a cloud's metadata — see `egress.ts`.
  try {
    await assertEgressAllowed(options.url);
  } catch (error) {
    if (!(error instanceof EgressRefusedError)) throw error;
    throw new NotificationError(
      error.describe(options.language ?? 'fr'),
      options.channel,
      'connect',
      error,
    );
  }

  let response: Response;
  try {
    response = await options.fetch(options.url, init);
  } catch (error) {
    // An unreachable URL, a silent DNS, a timeout: all here. `fetch`'s message
    // sometimes contains the whole URL, token included.
    throw new NotificationError(
      describeFailure(error, options.secrets, options.language),
      options.channel,
      'connect',
      error,
    );
  }

  const text = await response.text().catch(() => '');

  if (!response.ok) {
    const excerpt = redactSecrets(text.trim(), options.secrets, options.language).slice(0, 300);
    throw new NotificationError(
      `HTTP ${response.status}${excerpt.length > 0 ? ` — ${excerpt}` : ''}`,
      options.channel,
      'send',
    );
  }

  return { status: response.status, text };
}

/** Reads a string value in a JSON response, without ever throwing. */
export function jsonField(raw: string, ...path: string[]): string | null {
  let current: unknown;
  try {
    current = JSON.parse(raw);
  } catch {
    return null;
  }
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' && current.length > 0 ? current : null;
}
