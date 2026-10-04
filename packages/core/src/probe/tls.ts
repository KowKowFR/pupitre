import { connect, type PeerCertificate, type TLSSocket } from 'node:tls';
import { tlsConfigSchema, type TlsConfig } from '../monitors/catalog.js';
import type { Cidr } from '../monitors/ssrf.js';
import type { CheckResult } from '../monitors/state.js';
import type { UiLanguage } from '../i18n.js';
import { probeSay } from './messages.js';
import { ProbeTimeoutError, messageOf, resolveGuarded } from './net.js';
import type { MonitorProbe, ProbeContext } from './types.js';

/**
 * TLS certificate probe.
 *
 * It exists to prevent the dumbest and most total outage there is: an expired
 * certificate nobody saw coming. A handshake, then `getPeerCertificate()` — no
 * dependency.
 *
 * It is also the proof that the abstraction holds: this type is **not** an HTTP
 * request, and adding it required touching neither the table, nor the runner,
 * nor the routes, nor the screen.
 *
 * ── The choice worth writing down ───────────────────────────────────────────
 * A certificate expiring in ten days makes the probe **fail**, not merely warn.
 * A certificate probe is only useful if it alerts *before* the outage; waiting
 * for expiry would amount to observing the fire. The consequence is accepted and
 * documented in the catalog: a TLS probe's availability rate reads "share of
 * time the certificate was valid **and outside the notice period**".
 */

const MS_PER_DAY = 86_400_000;

/** `subject` and `issuer` are objects of X.509 fields; we draw a line from them. */
function distinguishedName(fields: PeerCertificate['issuer'] | undefined): string | null {
  if (!fields) return null;
  const record = fields as unknown as Record<string, string | string[] | undefined>;
  // CN first, O next: it is what a human recognizes of an issuer.
  for (const key of ['CN', 'O', 'OU']) {
    const value = record[key];
    const text = Array.isArray(value) ? value[0] : value;
    if (typeof text === 'string' && text !== '') return text;
  }
  return null;
}

function handshake(input: {
  address: string;
  port: number;
  servername: string;
  timeoutMs: number;
}): Promise<{ socket: TLSSocket; elapsedMs: number }> {
  // Monotonic clock: an NTP adjustment during the measurement must not produce a
  // negative or fanciful latency.
  const started = performance.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const socket = connect({
      // Connection to the checked **address**, SNI and verification on the name: the
      // same guarantee as the HTTP probe against DNS rebinding.
      host: input.address,
      port: input.port,
      servername: input.servername,
      // We want to know whether the chain is valid — that is half the point.
      rejectUnauthorized: true,
      timeout: input.timeoutMs,
    });

    socket.once('secureConnect', () =>
      finish(() => resolve({ socket, elapsedMs: Math.round(performance.now() - started) })),
    );
    socket.once('timeout', () =>
      finish(() => {
        socket.destroy();
        reject(new ProbeTimeoutError(input.timeoutMs));
      }),
    );
    socket.once('error', (error) => finish(() => reject(error)));
  });
}

async function runTls(
  config: TlsConfig,
  allowlist: readonly Cidr[],
  language: UiLanguage,
): Promise<CheckResult> {
  const say = probeSay(language);
  const servername = config.servername ?? config.host;

  let address: string;
  try {
    address = (await resolveGuarded(config.host, allowlist)).address;
  } catch (error) {
    return {
      outcome: 'unreachable',
      latencyMs: null,
      detail: messageOf(error, language),
      metrics: {},
    };
  }

  let socket: TLSSocket;
  let elapsedMs: number;
  try {
    ({ socket, elapsedMs } = await handshake({
      address,
      port: config.port,
      servername,
      timeoutMs: config.timeoutMs,
    }));
  } catch (error) {
    // An invalid chain or a name that does not match comes up here: it is indeed a
    // certificate failure, but we could not tell it from a closed port without
    // inspecting the code. We do.
    const code = (error as NodeJS.ErrnoException).code ?? '';
    const certificateProblem =
      code.startsWith('CERT_') ||
      code.startsWith('ERR_TLS') ||
      code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
      code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
      code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
      code === 'HOSTNAME_MISMATCH';
    return {
      outcome: certificateProblem ? 'unhealthy' : 'unreachable',
      latencyMs: null,
      detail: messageOf(error, language),
      metrics: { address },
    };
  }

  try {
    const certificate = socket.getPeerCertificate(false);
    const protocol = socket.getProtocol();

    if (!certificate.valid_to) {
      return {
        outcome: 'unhealthy',
        latencyMs: elapsedMs,
        detail: say('noCertificate'),
        metrics: { address, protocol, handshakeMs: elapsedMs },
      };
    }

    const validTo = new Date(certificate.valid_to);
    const validFrom = certificate.valid_from ? new Date(certificate.valid_from) : null;
    const now = Date.now();
    // Rounded down: "0 days left" on the day of expiry, not 1.
    const daysRemaining = Math.floor((validTo.getTime() - now) / MS_PER_DAY);

    const metrics = {
      address,
      protocol,
      handshakeMs: elapsedMs,
      daysRemaining,
      validTo: validTo.toISOString(),
      validFrom: validFrom?.toISOString() ?? null,
      issuer: distinguishedName(certificate.issuer),
      subject: distinguishedName(certificate.subject),
      serialNumber: certificate.serialNumber ?? null,
    };

    if (Number.isNaN(validTo.getTime())) {
      return {
        outcome: 'unhealthy',
        latencyMs: elapsedMs,
        detail: say('tls.unreadableExpiry', { value: certificate.valid_to }),
        metrics,
      };
    }
    if (validTo.getTime() <= now) {
      return {
        outcome: 'unhealthy',
        latencyMs: elapsedMs,
        detail: say('tls.expired', { count: Math.abs(daysRemaining) }),
        metrics,
      };
    }
    if (validFrom && validFrom.getTime() > now) {
      return {
        outcome: 'unhealthy',
        latencyMs: elapsedMs,
        detail: say('tls.notYetValid'),
        metrics,
      };
    }
    if (daysRemaining <= config.warnDays) {
      return {
        outcome: 'unhealthy',
        latencyMs: elapsedMs,
        detail: say('tls.expiresSoon', { count: daysRemaining, warnDays: config.warnDays }),
        metrics,
      };
    }

    return { outcome: 'healthy', latencyMs: elapsedMs, detail: null, metrics };
  } finally {
    socket.destroy();
  }
}

export const tlsProbe: MonitorProbe = {
  type: 'tls',
  async run(config, ctx: ProbeContext): Promise<CheckResult> {
    const parsed = tlsConfigSchema.safeParse(config);
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
    return runTls(parsed.data, ctx.allowlist, ctx.language);
  },
};
