import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { httpConfigSchema, type HttpConfig, type HttpMethod } from '../monitors/catalog.js';
import type { Cidr } from '../monitors/ssrf.js';
import {
  MONITOR_MAX_REDIRECTS,
  MONITOR_MAX_RESPONSE_BYTES,
  MONITOR_USER_AGENT,
  type CheckResult,
} from '../monitors/state.js';
import { SsrfBlockedError, messageOf, resolveUrlGuarded, type ResolvedTarget } from './net.js';
import type { MonitorProbe, ProbeContext } from './types.js';

/**
 * Sonde de disponibilité HTTP.
 *
 * Écrite avec `node:http` plutôt qu'avec `fetch`, pour trois raisons qui sont
 * toutes des exigences du brief, pas du confort :
 *
 *   1. **Se connecter à l'adresse littérale contrôlée**, avec `Host` et SNI du
 *      nom d'origine. C'est ce qui ferme la fenêtre de rebinding DNS entre le
 *      contrôle et la connexion — `fetch` re-résout le nom lui-même.
 *   2. **Suivre les redirections à la main**, pour re-contrôler chaque saut.
 *   3. **Borner la lecture** et couper la socket : `fetch` n'offre pas de
 *      plafond d'octets sans lire le flux entier.
 *
 * Le TTFB vient en prime : on mesure jusqu'aux en-têtes, pas jusqu'à la fin du
 * téléchargement. Ce qu'on veut savoir, c'est la réactivité du service, pas le
 * débit du lien ni le poids de la page.
 */

type HopResponse = {
  response: IncomingMessage;
  body: string;
  truncated: boolean;
  headersAtMs: number;
};

function requestOnce(input: {
  url: URL;
  target: ResolvedTarget;
  method: HttpMethod;
  timeoutMs: number;
  maxBytes: number;
  readBody: boolean;
}): Promise<HopResponse> {
  const secure = input.url.protocol === 'https:';
  const send = secure ? httpsRequest : httpRequest;
  const port = input.url.port === '' ? (secure ? 443 : 80) : Number(input.url.port);
  // Horloge monotone : un ajustement NTP pendant la mesure ne doit pas
  // produire une latence négative ou fantaisiste.
  const started = performance.now();

  return new Promise<HopResponse>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const request = send({
      // On se connecte à l'**adresse**, jamais au nom : c'est ce qui ferme la
      // fenêtre entre le contrôle et la connexion. L'en-tête `Host` et le SNI
      // portent le nom, donc le vhost et le certificat sont vérifiés comme il faut.
      host: input.target.address,
      port,
      path: `${input.url.pathname}${input.url.search}`,
      method: input.method,
      servername: secure ? input.target.hostname : undefined,
      rejectUnauthorized: true,
      headers: {
        host: input.url.port === '' ? input.target.hostname : `${input.target.hostname}:${port}`,
        'user-agent': MONITOR_USER_AGENT,
        accept: '*/*',
        // Pas de compression : on lit au plus quelques centaines de kio et on ne
        // veut pas déballer une bombe de décompression pour y chercher un mot-clé.
        'accept-encoding': 'identity',
        connection: 'close',
      },
      timeout: input.timeoutMs,
    });

    request.on('timeout', () => {
      finish(() => {
        request.destroy();
        reject(new Error(`délai dépassé après ${input.timeoutMs} ms`));
      });
    });

    request.on('error', (error) => finish(() => reject(error)));

    request.on('response', (response) => {
      const headersAtMs = Math.round(performance.now() - started);

      if (!input.readBody) {
        response.resume();
        finish(() => resolve({ response, body: '', truncated: false, headersAtMs }));
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;

      response.on('data', (chunk: Buffer) => {
        if (truncated) return;
        const room = input.maxBytes - size;
        if (chunk.byteLength >= room) {
          chunks.push(chunk.subarray(0, room));
          truncated = true;
          // On a de quoi chercher le mot-clé : on coupe la socket plutôt que de
          // laisser un flux sans fin nous occuper.
          response.destroy();
          finish(() =>
            resolve({
              response,
              body: Buffer.concat(chunks).toString('utf8'),
              truncated: true,
              headersAtMs,
            }),
          );
          return;
        }
        chunks.push(chunk);
        size += chunk.byteLength;
      });

      response.on('end', () => {
        finish(() =>
          resolve({
            response,
            body: Buffer.concat(chunks).toString('utf8'),
            truncated,
            headersAtMs,
          }),
        );
      });

      response.on('error', (error) => finish(() => reject(error)));
    });

    request.end();
  });
}

const REDIRECT_CODES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

async function runHttp(config: HttpConfig, allowlist: readonly Cidr[]): Promise<CheckResult> {
  const deadline = Date.now() + config.timeoutMs;

  let current = config.url;
  let redirects = 0;
  let latencyMs = 0;
  let address: string | null = null;

  const fail = (outcome: 'unhealthy' | 'unreachable', detail: string, status: number | null) =>
    ({
      outcome,
      latencyMs: outcome === 'unreachable' && status === null ? null : latencyMs,
      detail,
      metrics: {
        httpStatus: status,
        latencyMs: status === null ? null : latencyMs,
        redirects,
        address,
        finalUrl: current,
      },
    }) satisfies CheckResult;

  for (;;) {
    if (Date.now() >= deadline) {
      return fail('unreachable', `délai dépassé après ${config.timeoutMs} ms`, null);
    }

    let target: ResolvedTarget;
    let parsed: URL;
    try {
      // Chaque saut est re-résolu et re-contrôlé : une URL publique qui redirige
      // vers 169.254.169.254 s'arrête ici.
      const resolved = await resolveUrlGuarded(current, allowlist);
      target = resolved.target;
      parsed = resolved.parsed;
      address = target.address;
    } catch (error) {
      const blocked = error instanceof SsrfBlockedError;
      return fail(
        'unreachable',
        blocked
          ? `${redirects > 0 ? 'redirection refusée : ' : ''}${error.reason}`
          : messageOf(error),
        null,
      );
    }

    let hop: HopResponse;
    try {
      hop = await requestOnce({
        url: parsed,
        target,
        method: config.method,
        timeoutMs: Math.max(1, deadline - Date.now()),
        maxBytes: MONITOR_MAX_RESPONSE_BYTES,
        // HEAD n'a pas de corps ; sans mot-clé à chercher, on n'en lit pas non plus.
        readBody: config.method !== 'HEAD' && config.keyword !== null,
      });
    } catch (error) {
      return fail('unreachable', messageOf(error), null);
    }

    latencyMs += hop.headersAtMs;
    const status = hop.response.statusCode ?? 0;
    const location = hop.response.headers.location;

    if (REDIRECT_CODES.has(status) && typeof location === 'string' && location !== '') {
      if (redirects >= MONITOR_MAX_REDIRECTS) {
        return fail('unhealthy', `plus de ${MONITOR_MAX_REDIRECTS} redirections`, status);
      }
      try {
        current = new URL(location, current).toString();
      } catch {
        return fail('unhealthy', `redirection illisible vers « ${location} »`, status);
      }
      redirects += 1;
      continue;
    }

    if (status !== config.expectedStatus) {
      return fail('unhealthy', `code ${status}, ${config.expectedStatus} attendu`, status);
    }

    if (config.keyword !== null && !hop.body.includes(config.keyword)) {
      return fail(
        'unhealthy',
        hop.truncated
          ? `mot-clé « ${config.keyword} » absent des ${MONITOR_MAX_RESPONSE_BYTES} premiers octets`
          : `mot-clé « ${config.keyword} » absent de la réponse`,
        status,
      );
    }

    return {
      outcome: 'healthy',
      latencyMs,
      detail: null,
      metrics: {
        httpStatus: status,
        latencyMs,
        redirects,
        address,
        finalUrl: current,
      },
    };
  }
}

export const httpProbe: MonitorProbe = {
  type: 'http',
  async run(config, ctx: ProbeContext): Promise<CheckResult> {
    const parsed = httpConfigSchema.safeParse(config);
    if (!parsed.success) {
      return {
        outcome: 'unreachable',
        latencyMs: null,
        detail: `configuration de sonde invalide : ${parsed.error.issues.map((issue) => issue.message).join(', ')}`,
        metrics: {},
      };
    }
    return runHttp(parsed.data, ctx.allowlist);
  },
};
