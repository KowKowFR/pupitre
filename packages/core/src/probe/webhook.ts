import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Cidr } from '../monitors/ssrf.js';
import { MONITOR_USER_AGENT } from '../monitors/state.js';
import type { UiLanguage } from '../i18n.js';
import { probeSay } from './messages.js';
import { messageOf, resolveUrlGuarded } from './net.js';

export type WebhookDelivery = { ok: true; status: number } | { ok: false; error: string };

/**
 * Émet une charge utile JSON vers un récepteur.
 *
 * Le webhook part du worker vers une URL fournie par un utilisateur : **même
 * politique SSRF que les sondes**, sans exception. C'est exactement la même
 * surface d'attaque, et l'oublier ici annulerait tout le reste.
 */
export async function postWebhook(input: {
  url: string;
  payload: unknown;
  allowlist: readonly Cidr[];
  timeoutMs?: number;
  /** La langue de l'erreur rendue — celle de l'instance. */
  language?: UiLanguage;
}): Promise<WebhookDelivery> {
  const timeoutMs = input.timeoutMs ?? 10_000;
  const language = input.language ?? 'fr';

  let target: Awaited<ReturnType<typeof resolveUrlGuarded>>;
  try {
    target = await resolveUrlGuarded(input.url, input.allowlist);
  } catch (error) {
    return { ok: false, error: messageOf(error, language) };
  }

  const url = target.parsed;
  const secure = url.protocol === 'https:';
  const send = secure ? httpsRequest : httpRequest;
  const port = url.port === '' ? (secure ? 443 : 80) : Number(url.port);
  const body = Buffer.from(JSON.stringify(input.payload), 'utf8');

  return new Promise<WebhookDelivery>((resolve) => {
    let settled = false;
    const finish = (value: WebhookDelivery): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const request = send({
      host: target.target.address,
      port,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      servername: secure ? target.target.hostname : undefined,
      rejectUnauthorized: true,
      headers: {
        host: url.port === '' ? target.target.hostname : `${target.target.hostname}:${port}`,
        'content-type': 'application/json',
        'content-length': String(body.byteLength),
        'user-agent': MONITOR_USER_AGENT,
        connection: 'close',
      },
      timeout: timeoutMs,
    });

    request.on('timeout', () => {
      request.destroy();
      finish({ ok: false, error: probeSay(language)('timeout', { ms: timeoutMs }) });
    });
    request.on('error', (error) => finish({ ok: false, error: messageOf(error, language) }));
    request.on('response', (response) => {
      response.resume();
      const status = response.statusCode ?? 0;
      finish(
        status >= 200 && status < 300
          ? { ok: true, status }
          : { ok: false, error: probeSay(language)('webhook.status', { status }) },
      );
    });

    request.write(body);
    request.end();
  });
}
