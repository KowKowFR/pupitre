import { httpConfigSchema, type HttpConfig } from '../monitors/catalog.js';
import type { Cidr } from '../monitors/ssrf.js';
import { MONITOR_MAX_RESPONSE_BYTES, type CheckResult } from '../monitors/state.js';
import { decodeBody, guardedFetch } from './fetch.js';
import type { MonitorProbe, ProbeContext } from './types.js';

/**
 * Sonde de disponibilité HTTP.
 *
 * Elle ne fait plus la requête elle-même : la boucle de redirection gardée vit
 * dans `fetch.ts`, partagée avec la sonde de mot-clé et avec le client RDAP.
 * C'est délibéré — c'est le morceau qui referme le SSRF par redirection, et
 * chaque copie serait une occasion de diverger. Il ne reste ici que ce qui est
 * propre au type : le verdict, et les mesures qu'il rend.
 */

async function runHttp(config: HttpConfig, allowlist: readonly Cidr[]): Promise<CheckResult> {
  const result = await guardedFetch({
    url: config.url,
    method: config.method,
    timeoutMs: config.timeoutMs,
    maxBytes: MONITOR_MAX_RESPONSE_BYTES,
    // HEAD n'a pas de corps ; sans mot-clé à chercher, on n'en lit pas non plus.
    readBody: config.method !== 'HEAD' && config.keyword !== null,
    allowlist,
  });

  const metrics = (status: number | null, latencyMs: number | null) => ({
    httpStatus: status,
    latencyMs,
    redirects: result.redirects,
    address: result.address,
    finalUrl: result.finalUrl,
  });

  if (!result.ok) {
    // Une redirection cassée est une cible qui a répondu, mal : `unhealthy`.
    // Un refus SSRF ou une panne réseau, c'est « rien n'a répondu ».
    const outcome = result.kind === 'redirect' ? 'unhealthy' : 'unreachable';
    return {
      outcome,
      latencyMs: result.status === null ? null : result.latencyMs,
      detail: result.detail,
      metrics: metrics(result.status, result.status === null ? null : result.latencyMs),
    };
  }

  const fail = (detail: string): CheckResult => ({
    outcome: 'unhealthy',
    latencyMs: result.latencyMs,
    detail,
    metrics: metrics(result.status, result.latencyMs),
  });

  if (result.status !== config.expectedStatus) {
    return fail(`code ${result.status}, ${config.expectedStatus} attendu`);
  }

  if (config.keyword !== null) {
    const body = decodeBody(result.body, result.headers['content-type']);
    if (!body.includes(config.keyword)) {
      return fail(
        result.truncated
          ? `mot-clé « ${config.keyword} » absent des ${MONITOR_MAX_RESPONSE_BYTES} premiers octets`
          : `mot-clé « ${config.keyword} » absent de la réponse`,
      );
    }
  }

  return {
    outcome: 'healthy',
    latencyMs: result.latencyMs,
    detail: null,
    metrics: metrics(result.status, result.latencyMs),
  };
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
