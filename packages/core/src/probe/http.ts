import { httpConfigSchema, type HttpConfig } from '../monitors/catalog.js';
import type { Cidr } from '../monitors/ssrf.js';
import { MONITOR_MAX_RESPONSE_BYTES, type CheckResult } from '../monitors/state.js';
import { certificateMetrics, decodeBody, guardedFetch } from './fetch.js';
import type { UiLanguage } from '../i18n.js';
import { probeSay } from './messages.js';
import type { MonitorProbe, ProbeContext } from './types.js';

/**
 * HTTP availability probe.
 *
 * It no longer makes the request itself: the guarded redirect loop lives in
 * `fetch.ts`, shared with the keyword probe and the RDAP client. It is
 * deliberate — it is the piece that closes SSRF through redirects, and each copy
 * would be a chance to diverge. Only what is specific to the type remains here:
 * the verdict, and the measurements it returns.
 */

async function runHttp(
  config: HttpConfig,
  allowlist: readonly Cidr[],
  language: UiLanguage,
): Promise<CheckResult> {
  const result = await guardedFetch({
    url: config.url,
    method: config.method,
    timeoutMs: config.timeoutMs,
    maxBytes: MONITOR_MAX_RESPONSE_BYTES,
    // HEAD has no body; without a keyword to look for, we do not read one either.
    readBody: config.method !== 'HEAD' && config.keyword !== null,
    allowlist,
    language,
  });
  const say = probeSay(language);

  const metrics = (status: number | null, latencyMs: number | null) => ({
    httpStatus: status,
    latencyMs,
    redirects: result.redirects,
    address: result.address,
    finalUrl: result.finalUrl,
    ...(result.ok ? certificateMetrics(result.certificate) : {}),
  });

  if (!result.ok) {
    // A broken redirect is a target that answered, badly: `unhealthy`. An SSRF
    // refusal or a network failure is "nothing answered".
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
    return fail(say('http.status', { status: result.status, expected: config.expectedStatus }));
  }

  if (config.keyword !== null) {
    const body = decodeBody(result.body, result.headers['content-type']);
    if (!body.includes(config.keyword)) {
      return fail(
        result.truncated
          ? say('http.keywordMissingTruncated', {
              keyword: config.keyword,
              bytes: MONITOR_MAX_RESPONSE_BYTES,
            })
          : say('http.keywordMissing', { keyword: config.keyword }),
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
        detail: probeSay(ctx.language)('invalidConfig', {
          issues: parsed.error.issues.map((issue) => issue.message).join(', '),
        }),
        metrics: {},
      };
    }
    return runHttp(parsed.data, ctx.allowlist, ctx.language);
  },
};
