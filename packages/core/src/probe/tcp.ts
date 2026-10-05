import { Socket } from 'node:net';
import { tcpConfigSchema, type TcpConfig } from '../monitors/catalog.js';
import type { Cidr } from '../monitors/ssrf.js';
import type { CheckResult } from '../monitors/state.js';
import type { UiLanguage } from '../i18n.js';
import { probeSay } from './messages.js';
import { ProbeTimeoutError, messageOf, resolveGuarded } from './net.js';
import type { MonitorProbe, ProbeContext } from './types.js';

/**
 * TCP port probe.
 *
 * ── What it establishes, and the nuance that makes it useful ────────────────
 * The TCP handshake proves **that a process accepts connections**. Nothing more,
 * and that is already a lot: an `ECONNREFUSED` on a database's port means the
 * service stopped or the firewall closed again, and that is precisely what an
 * HTTP probe does not see of a service that does not speak HTTP.
 *
 * But a frozen process keeps its listening socket: it still accepts the
 * handshake while being unable to serve. Hence the **expected banner**, as an
 * option: SMTP, SSH, FTP, IMAP and POP3 announce their identity *before* anyone
 * speaks. Waiting for `SSH-2.0` or `220 ` moves from "a port is open" to "the
 * right service, alive, listens behind it".
 *
 * We **never** send anything — not a byte. A probe observes; prodding an unknown
 * service every minute pollutes it (access logs, anti-abuse counters) and would
 * assume knowing which protocol it speaks. Services where the client speaks
 * first (PostgreSQL, MySQL, HTTP) will therefore never return a banner — it is
 * documented in the catalog, and the failure message reminds it.
 *
 * ── The guard, and why it is more critical here than elsewhere ──────────────
 * A probe that takes a host and a port *is* the primitive of an internal network
 * scanner: it returns, in clear, "this port accepts / refuses / does not
 * answer", that is `nmap`'s output. It is **more** dangerous than the HTTP
 * probe, which at least stumbles on services that do not speak HTTP.
 *
 * It therefore goes through the same `resolveGuarded()` as the others, and
 * connects to the chosen **literal** address: there is no second resolution
 * between the check and the connection, hence no rebinding window. No path in
 * this file opens a socket to anything other than that address.
 */

/** What we read of a banner. Beyond it, it is a stream, not an announcement. */
const BANNER_MAX_BYTES = 512;

type Handshake = {
  connectMs: number;
  banner: string | null;
  bannerMs: number | null;
  /** True if a banner was expected and the timeout expired with nothing. */
  bannerTimedOut: boolean;
};

function connectAndListen(input: {
  address: string;
  port: number;
  timeoutMs: number;
  wantBanner: boolean;
}): Promise<Handshake> {
  // Monotonic clock: an NTP adjustment during the measurement must not produce a
  // negative or fanciful latency.
  const started = performance.now();

  return new Promise<Handshake>((resolve, reject) => {
    let settled = false;
    let connectMs = 0;
    let connected = false;
    const chunks: Buffer[] = [];
    let size = 0;

    const socket = new Socket();
    socket.setTimeout(input.timeoutMs);

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    const done = (bannerTimedOut: boolean): void => {
      const banner = chunks.length === 0 ? null : Buffer.concat(chunks).toString('utf8');
      finish(() =>
        resolve({
          connectMs,
          // A banner is not guaranteed text: we only keep what prints, on one line, so
          // that the measurement stays readable in the database and in an alert.
          banner: banner === null ? null : sanitizeBanner(banner),
          bannerMs: banner === null ? null : Math.round(performance.now() - started) - connectMs,
          bannerTimedOut,
        }),
      );
    };

    socket.on('connect', () => {
      connected = true;
      connectMs = Math.round(performance.now() - started);
      // Without an expected banner, the handshake is the whole measurement: we close
      // right away rather than leave a socket open at the target.
      if (!input.wantBanner) done(false);
    });

    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk.subarray(0, BANNER_MAX_BYTES - size));
      size += chunk.byteLength;
      // A banner fits on one line: as soon as we see it finished, we do not wait for
      // the full timeout to return.
      if (size >= BANNER_MAX_BYTES || chunk.includes(0x0a)) done(false);
    });

    // The service closed without saying anything: we still established the
    // connection.
    socket.on('end', () => done(false));

    socket.on('timeout', () => {
      // Telling the two timeouts apart is what allows an honest message: "the port
      // accepts but announces nothing" is not "the port does not answer".
      if (connected) done(true);
      else finish(() => reject(new ProbeTimeoutError(input.timeoutMs)));
    });

    socket.on('error', (error) => finish(() => reject(error)));

    // Connection to the checked **address**, never to the name: the same
    // anti-rebinding guarantee as the HTTP and TLS probes.
    socket.connect({ host: input.address, port: input.port });
  });
}

function sanitizeBanner(value: string): string {
  return value
    .replace(/\r?\n/g, ' ')
    // A banner can be binary — a TLS server answers with an alert of raw bytes. We
    // remove what does not print rather than write control characters into the
    // database and the alerts.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 200);
}

async function runTcp(
  config: TcpConfig,
  allowlist: readonly Cidr[],
  language: UiLanguage,
): Promise<CheckResult> {
  const say = probeSay(language);
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

  let handshake: Handshake;
  try {
    handshake = await connectAndListen({
      address,
      port: config.port,
      timeoutMs: config.timeoutMs,
      wantBanner: config.expectBanner !== null,
    });
  } catch (error) {
    // Refusal, filtering, timeout: nothing reachable listens. It is `unreachable`,
    // not `unhealthy` — the target did not answer wrongly, it did not answer.
    return {
      outcome: 'unreachable',
      latencyMs: null,
      detail: messageOf(error, language),
      metrics: { address },
    };
  }

  const metrics = {
    address,
    connectMs: handshake.connectMs,
    banner: handshake.banner,
    bannerMs: handshake.bannerMs,
  };

  if (config.expectBanner === null) {
    return { outcome: 'healthy', latencyMs: handshake.connectMs, detail: null, metrics };
  }

  if (handshake.banner === null) {
    // The port accepts, the service does not announce itself: the connection is a
    // success, the probe is not. `unhealthy` and not `unreachable` — the
    // distinction is the whole point of waiting for a banner.
    return {
      outcome: 'unhealthy',
      latencyMs: handshake.connectMs,
      detail: handshake.bannerTimedOut
        ? say('tcp.silentBanner', { ms: config.timeoutMs })
        : say('tcp.closedSilently'),
      metrics,
    };
  }

  // Case-insensitive: a banner's case is set by the protocol, not by the operator,
  // and nobody should have to guess it.
  const found = handshake.banner.toLowerCase().includes(config.expectBanner.toLowerCase());
  if (!found) {
    return {
      outcome: 'unhealthy',
      latencyMs: handshake.connectMs,
      detail: say('tcp.wrongBanner', { expected: config.expectBanner, banner: handshake.banner }),
      metrics,
    };
  }

  return { outcome: 'healthy', latencyMs: handshake.connectMs, detail: null, metrics };
}

export const tcpProbe: MonitorProbe = {
  type: 'tcp',
  async run(config, ctx: ProbeContext): Promise<CheckResult> {
    const parsed = tcpConfigSchema.safeParse(config);
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
    return runTcp(parsed.data, ctx.allowlist, ctx.language);
  },
};
