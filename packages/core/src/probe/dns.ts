import { Resolver } from 'node:dns/promises';
import { dnsConfigSchema, type DnsConfig } from '../monitors/catalog.js';
import {
  compareDnsRecords,
  describeDnsComparison,
  normalizeDnsName,
  parseExpectedRecords,
  type DnsRecordType,
} from '../monitors/dns-records.js';
import { checkAddress, ssrfRefusalText, type Cidr } from '../monitors/ssrf.js';
import type { UiLanguage } from '../i18n.js';
import { probeSay } from './messages.js';
import type { CheckResult } from '../monitors/state.js';
import { messageOf } from './net.js';
import type { MonitorProbe, ProbeContext } from './types.js';

/**
 * DNS record probe.
 *
 * ── What the SSRF guard means here, and it is the subtle point ──────────────
 * The other probes connect to what they monitor; this one does **not**. It asks
 * a question *about* a name, to a resolver. The addresses it gets are **data**:
 * compared, never reached. Submitting them to the address check would be absurd
 * — monitoring "the A of `db.internal` is indeed 10.0.0.5" is perfectly
 * legitimate, and reaches nothing.
 *
 * The rule that covers every type without a special case is therefore: **the
 * guard applies to every endpoint the worker opens a socket to**. Here, that
 * endpoint is the resolver, and it is what is checked — with an explicit
 * exception for the system's resolver, which is not a user input but a
 * deployment fact (in a container, it is often `127.0.0.11`, which the guard
 * would wrongly refuse).
 *
 * ── Why `Resolver` and not `dns.resolve` ────────────────────────────────────
 * A `Resolver` instance carries its own servers and its own timeout. The global
 * module's functions share a process configuration: pointing them at a probe's
 * resolver would change the resolution of **the whole worker**, SSH deployments
 * included. One instance per measurement, thrown away after, is the only correct
 * form.
 *
 * `Resolver` also does the other things needed: it queries the requested type
 * (`resolveMx`, `resolveCaa`…) instead of going through `getaddrinfo`, it does
 * not follow the system's search suffix, and it returns structured records
 * rather than text to parse again.
 */

/** An answer, reduced to displayable strings — the comparison does the rest. */
type Answer = { values: string[]; minTtl: number | null };

async function query(
  resolver: Resolver,
  name: string,
  type: DnsRecordType,
): Promise<Answer> {
  switch (type) {
    case 'A': {
      // `ttl: true`: the TTL is not an outage signal, but it explains why a fix takes
      // time to show. It is the question one always asks during an incident.
      const records = await resolver.resolve4(name, { ttl: true });
      return {
        values: records.map((record) => record.address),
        minTtl: records.length === 0 ? null : Math.min(...records.map((r) => r.ttl)),
      };
    }
    case 'AAAA': {
      const records = await resolver.resolve6(name, { ttl: true });
      return {
        values: records.map((record) => record.address),
        minTtl: records.length === 0 ? null : Math.min(...records.map((r) => r.ttl)),
      };
    }
    case 'CNAME':
      return { values: await resolver.resolveCname(name), minTtl: null };
    case 'NS':
      return { values: await resolver.resolveNs(name), minTtl: null };
    case 'MX': {
      const records = await resolver.resolveMx(name);
      return {
        values: records.map((record) => `${record.priority} ${record.exchange}`),
        minTtl: null,
      };
    }
    case 'SRV': {
      const records = await resolver.resolveSrv(name);
      return {
        values: records.map(
          (record) => `${record.priority} ${record.weight} ${record.port} ${record.name}`,
        ),
        minTtl: null,
      };
    }
    case 'CAA': {
      const records = await resolver.resolveCaa(name);
      return {
        values: records.map((record) => {
          // Node returns `{ critical, type: 'CAA', issue }`: one property per tag, plus
          // two shape fields. `type` is not a CAA tag — forgetting it would compare
          // "0 type CAA" instead of "0 issue pki.goog".
          const critical = record.critical ?? 0;
          const entry = Object.entries(record).find(
            ([key]) => key !== 'critical' && key !== 'type',
          );
          return entry ? `${critical} ${entry[0]} ${String(entry[1])}` : `${critical} ?`;
        }),
        minTtl: null,
      };
    }
    default: {
      // TXT. Node returns the chunks of one string separately: we glue them back,
      // because a TXT split at 255 bytes stays a single value.
      const records = await resolver.resolveTxt(name);
      return { values: records.map((chunks) => chunks.join('')), minTtl: null };
    }
  }
}

/** `ENOTFOUND` and `ENODATA` are findings, not worker failures. */
const EMPTY_CODES: ReadonlySet<string> = new Set(['ENOTFOUND', 'ENODATA']);

/**
 * Length kept of a list of values, in characters.
 *
 * A serious domain readily carries seventeen TXT records (SPF, DKIM, DMARC and
 * one ownership proof per provider): copying them whole into `metrics`, then
 * again into `unexpected`, then into the alert message, would make a few
 * kilobytes per measurement — ninety-six measurements per day per probe. We cut:
 * what matters in an alert fits in the first values, and the full list can be
 * read again with a `dig`.
 */
const VALUES_MAX_CHARS = 400;

function summarize(values: readonly string[]): string | null {
  if (values.length === 0) return null;
  const joined = values.join(', ');
  if (joined.length <= VALUES_MAX_CHARS) return joined;
  const kept: string[] = [];
  let size = 0;
  for (const value of values) {
    if (size + value.length > VALUES_MAX_CHARS) break;
    kept.push(value);
    size += value.length + 2;
  }
  const hidden = values.length - kept.length;
  return `${kept.join(', ')}… (+${hidden})`;
}

async function runDns(
  config: DnsConfig,
  allowlist: readonly Cidr[],
  language: UiLanguage,
): Promise<CheckResult> {
  const say = probeSay(language);
  const name = normalizeDnsName(config.name);

  const resolver = new Resolver({ timeout: config.timeoutMs, tries: 1 });
  if (config.resolver !== null) {
    // A **declared** resolver is a user input: it goes through the guard, like any
    // connection target. It is the only place in this probe where an address is
    // judged.
    const verdict = checkAddress(config.resolver, allowlist);
    if (!verdict.allowed) {
      return {
        outcome: 'unreachable',
        latencyMs: null,
        detail: say('dns.resolverRefused', {
          reason: ssrfRefusalText(verdict.refusal, language),
        }),
        metrics: { resolver: config.resolver },
      };
    }
    resolver.setServers([config.resolver]);
  }

  const resolverLabel =
    config.resolver ?? say('dns.systemResolver', { servers: resolver.getServers().join(', ') });
  const expected = parseExpectedRecords(config.recordType, config.expected);

  const started = performance.now();
  let answer: Answer;
  try {
    answer = await query(resolver, name, config.recordType);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    const resolveMs = Math.round(performance.now() - started);
    // The name does not exist, or has no record of this type. The resolver
    // answered: it is not `unreachable`, it is an answer that is not the expected
    // one. The nuance matters — `unreachable` would mean "I could not look", whereas
    // here we did look.
    if (EMPTY_CODES.has(code)) {
      return {
        outcome: 'unhealthy',
        latencyMs: resolveMs,
        detail:
          code === 'ENOTFOUND'
            ? say('dns.nxdomain', { name })
            : say('dns.noRecord', { name, type: config.recordType }),
        metrics: { resolveMs, recordCount: 0, values: null, resolver: resolverLabel },
      };
    }
    return {
      outcome: 'unreachable',
      latencyMs: null,
      detail: messageOf(error, language),
      metrics: { resolver: resolverLabel },
    };
  }

  const resolveMs = Math.round(performance.now() - started);
  const metrics = {
    resolveMs,
    recordCount: answer.values.length,
    // `metrics` only accepts a number, a string or `null`: a list is serialized. The
    // comma is a display separator, not a data one — the comparison works on the
    // list.
    values: summarize(answer.values),
    resolver: resolverLabel,
    minTtl: answer.minTtl,
    missing: null as string | null,
    unexpected: null as string | null,
  };

  if (answer.values.length === 0) {
    return {
      outcome: 'unhealthy',
      latencyMs: resolveMs,
      detail: say('dns.noRecord', { name, type: config.recordType }),
      metrics,
    };
  }

  // No declared value: the probe observes presence, and that is all it claims to
  // do. It is the useful setting for "does this name still resolve", without
  // having to freeze an address that legitimately moves (CDN, hosting switch).
  if (expected.length === 0) {
    return { outcome: 'healthy', latencyMs: resolveMs, detail: null, metrics };
  }

  const comparison = compareDnsRecords({
    type: config.recordType,
    expected,
    actual: answer.values,
    match: config.match,
  });

  metrics.missing = summarize(comparison.missing);
  metrics.unexpected = summarize(comparison.unexpected);

  if (!comparison.ok) {
    return {
      outcome: 'unhealthy',
      latencyMs: resolveMs,
      detail: say('dns.mismatch', {
        type: config.recordType,
        name,
        comparison: describeDnsComparison(comparison, VALUES_MAX_CHARS, language),
      }),
      metrics,
    };
  }

  return { outcome: 'healthy', latencyMs: resolveMs, detail: null, metrics };
}

export const dnsProbe: MonitorProbe = {
  type: 'dns',
  async run(config, ctx: ProbeContext): Promise<CheckResult> {
    const parsed = dnsConfigSchema.safeParse(config);
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
    return runDns(parsed.data, ctx.allowlist, ctx.language);
  },
};
