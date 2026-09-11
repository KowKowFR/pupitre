import type { ChannelConfig, NotificationChannelKind } from './catalog.js';
import { NotificationError, describeFailure, redactSecrets, type FetchLike } from './types.js';

/**
 * Appel HTTP commun aux trois canaux qui en font un — Telegram, Discord,
 * webhook. Trois fois la même prudence : une borne de temps, un corps d'erreur
 * tronqué, et **rien** qui ressemble à un jeton dans le message remonté.
 *
 * Le `fetch` est reçu en argument et non importé : c'est ce qui permet de
 * vérifier la forme d'une charge utile sans réseau.
 */

export type HttpCallOptions = {
  channel: NotificationChannelKind;
  fetch: FetchLike;
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  /** Valeurs à masquer dans tout message d'erreur remonté. */
  secrets: ChannelConfig;
};

export type HttpCallResult = { status: number; text: string };

export async function httpCall(options: HttpCallOptions): Promise<HttpCallResult> {
  const init: RequestInit = {
    method: options.method,
    headers: {
      accept: 'application/json',
      'user-agent': 'bootstrap-tp-v2/notifications',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    signal: AbortSignal.timeout(options.timeoutMs),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  };

  let response: Response;
  try {
    response = await options.fetch(options.url, init);
  } catch (error) {
    // Une URL injoignable, un DNS muet, un délai dépassé : tous ici. Le message
    // de `fetch` contient parfois l'URL entière, jeton compris.
    throw new NotificationError(
      describeFailure(error, options.secrets),
      options.channel,
      'connect',
      error,
    );
  }

  const text = await response.text().catch(() => '');

  if (!response.ok) {
    const excerpt = redactSecrets(text.trim(), options.secrets).slice(0, 300);
    throw new NotificationError(
      `HTTP ${response.status}${excerpt.length > 0 ? ` — ${excerpt}` : ''}`,
      options.channel,
      'send',
    );
  }

  return { status: response.status, text };
}

/** Lit une valeur de chaîne dans une réponse JSON, sans jamais lever. */
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
