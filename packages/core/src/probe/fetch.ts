import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { TLSSocket } from 'node:tls';
import type { Cidr } from '../monitors/ssrf.js';
import { MONITOR_MAX_REDIRECTS, MONITOR_USER_AGENT } from '../monitors/state.js';
import type { UiLanguage } from '../i18n.js';
import { probeSay } from './messages.js';
import {
  ProbeTimeoutError,
  SsrfBlockedError,
  messageOf,
  resolveUrlGuarded,
  type ResolvedTarget,
} from './net.js';

/**
 * The **guarded** HTTP request — a single copy, for every probe that speaks
 * HTTP.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * The redirect loop is the most sensitive piece of code in monitoring: it is
 * what resolves and checks **each hop** again, hence what closes SSRF through
 * redirects. Each probe type speaking HTTP with its own copy of this loop would
 * be a chance to forget it — and the second copy always diverges from the
 * first. It therefore lives here, once, and `http.ts`, `keyword.ts` and the RDAP
 * client of `domain.ts` all three use it.
 *
 * ── Why not `fetch` ─────────────────────────────────────────────────────────
 * Three requirements `fetch` cannot meet:
 *
 *   1. **Connect to the checked literal address**, with the original name's
 *      `Host` and SNI. That is what closes the DNS rebinding window between the
 *      check and the connection — `fetch` resolves the name again itself.
 *   2. **Follow redirects by hand**, to check each hop again.
 *   3. **Bound the read** and cut the socket: `fetch` offers no byte cap without
 *      reading the whole stream.
 *
 * TTFB comes as a bonus: we measure up to the headers, not to the end of the
 * download. What we want to know is the service's responsiveness, not the
 * link's throughput or the page's weight.
 *
 * ── The allow list is a **parameter**, not a constant ───────────────────────
 * `MONITOR_ALLOWED_CIDRS` opens internal ranges to monitor *the operator's
 * fleet*. A request to a third party the operator did not choose — a registry's
 * RDAP server, designated by IANA's bootstrap list — must **not** inherit that
 * opening: otherwise a poisoned DNS record would bring an outgoing request into
 * the internal network. Those calls go through `allowlist: PUBLIC_ONLY`. See
 * `monitors/ssrf.ts`.
 */

/** No internal range. To pass for any request to a third party not chosen. */
export const PUBLIC_ONLY: readonly Cidr[] = [];

export type GuardedFetchInput = {
  url: string;
  method: 'GET' | 'HEAD' | 'POST';
  timeoutMs: number;
  /** Cap of bytes read. Beyond it, the socket is cut and `truncated` is true. */
  maxBytes: number;
  /** `false` to not read the body at all (HEAD, or nothing to look for in it). */
  readBody: boolean;
  allowlist: readonly Cidr[];
  /** The language of a failure's `detail` — the instance's. */
  language: UiLanguage;
  accept?: string;
  maxRedirects?: number;
  /**
   * Forbids `http:` even at the start. For exchanges that have no reason to be in
   * clear — an RDAP response altered in transit would say anything about a
   * domain's expiry.
   */
  requireHttps?: boolean;
};

/** What we keep of the certificate presented by the last https hop. */
export type PeerCertificateSummary = {
  /** End of validity, ISO 8601. */
  validTo: string;
};

export type GuardedFetchSuccess = {
  ok: true;
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
  /** Sum of the TTFBs of all hops. */
  latencyMs: number;
  redirects: number;
  address: string;
  finalUrl: string;
  /**
   * The certificate of the page finally served — `null` when it is served in
   * clear. It was already verified (`rejectUnauthorized`): we only keep its end
   * date, to see an expiry coming before it cuts the site.
   */
  certificate: PeerCertificateSummary | null;
};

export type GuardedFetchFailure = {
  ok: false;
  /**
   * `blocked` and `network`: nothing usable came back — it is `unreachable` on
   * the verdict side. `redirect`: the target did answer, badly — its redirects are
   * broken, it is `unhealthy`, and `status` is filled in.
   */
  kind: 'blocked' | 'network' | 'redirect';
  detail: string;
  status: number | null;
  latencyMs: number;
  redirects: number;
  address: string | null;
  finalUrl: string;
};

export type GuardedFetchResult = GuardedFetchSuccess | GuardedFetchFailure;

type HopResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
  headersAtMs: number;
  certificate: PeerCertificateSummary | null;
};

/**
 * Reads the certificate on the response's socket, while it is open. An
 * unreadable date counts as "no information": the probe makes nothing up.
 */
function certificateOf(socket: unknown): PeerCertificateSummary | null {
  const tls = socket as Partial<TLSSocket> | null;
  if (!tls || typeof tls.getPeerCertificate !== 'function') return null;
  const validTo = tls.getPeerCertificate(false)?.valid_to;
  if (!validTo) return null;
  const date = new Date(validTo);
  return Number.isNaN(date.getTime()) ? null : { validTo: date.toISOString() };
}

function requestOnce(input: {
  url: URL;
  target: ResolvedTarget;
  method: 'GET' | 'HEAD' | 'POST';
  timeoutMs: number;
  maxBytes: number;
  readBody: boolean;
  accept: string;
}): Promise<HopResponse> {
  const secure = input.url.protocol === 'https:';
  const send = secure ? httpsRequest : httpRequest;
  const port = input.url.port === '' ? (secure ? 443 : 80) : Number(input.url.port);
  // Monotonic clock: an NTP adjustment during the measurement must not produce a
  // negative or fanciful latency.
  const started = performance.now();

  return new Promise<HopResponse>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const request = send({
      // We connect to the **address**, never to the name: that is what closes the
      // window between the check and the connection. The `Host` header and the SNI
      // carry the name, so the vhost and the certificate are verified properly.
      host: input.target.address,
      port,
      path: `${input.url.pathname}${input.url.search}`,
      method: input.method,
      servername: secure ? input.target.hostname : undefined,
      rejectUnauthorized: true,
      headers: {
        host: input.url.port === '' ? input.target.hostname : `${input.target.hostname}:${port}`,
        'user-agent': MONITOR_USER_AGENT,
        accept: input.accept,
        // No compression: we read a few hundred KiB at most and do not want to unpack a
        // decompression bomb to look for a keyword in it.
        'accept-encoding': 'identity',
        connection: 'close',
      },
      timeout: input.timeoutMs,
    });

    request.on('timeout', () => {
      finish(() => {
        request.destroy();
        reject(new ProbeTimeoutError(input.timeoutMs));
      });
    });

    request.on('error', (error) => finish(() => reject(error)));

    request.on('response', (response) => {
      const headersAtMs = Math.round(performance.now() - started);
      const status = response.statusCode ?? 0;
      const headers = response.headers;
      // To read now: once the body is consumed, the socket is closed.
      const certificate = secure ? certificateOf(response.socket) : null;

      if (!input.readBody) {
        response.resume();
        finish(() =>
          resolve({
            status,
            headers,
            body: Buffer.alloc(0),
            truncated: false,
            headersAtMs,
            certificate,
          }),
        );
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
          // We have enough to look for the keyword: we cut the socket rather than let an
          // endless stream keep us busy.
          response.destroy();
          finish(() =>
            resolve({
              status,
              headers,
              body: Buffer.concat(chunks),
              truncated: true,
              headersAtMs,
              certificate,
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
            status,
            headers,
            body: Buffer.concat(chunks),
            truncated,
            headersAtMs,
            certificate,
          }),
        );
      });

      response.on('error', (error) => finish(() => reject(error)));
    });

    request.end();
  });
}

const REDIRECT_CODES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * An HTTP request, redirects included, each hop resolved and checked again.
 * **Never throws**: a dead target is a result.
 */
export async function guardedFetch(input: GuardedFetchInput): Promise<GuardedFetchResult> {
  const deadline = Date.now() + input.timeoutMs;
  const maxRedirects = input.maxRedirects ?? MONITOR_MAX_REDIRECTS;
  const accept = input.accept ?? '*/*';
  const language = input.language;
  const say = probeSay(language);

  let current = input.url;
  let redirects = 0;
  let latencyMs = 0;
  let address: string | null = null;

  const fail = (
    kind: GuardedFetchFailure['kind'],
    detail: string,
    status: number | null,
  ): GuardedFetchFailure => ({
    ok: false,
    kind,
    detail,
    status,
    latencyMs,
    redirects,
    address,
    finalUrl: current,
  });

  for (;;) {
    if (Date.now() >= deadline) {
      return fail('network', say('timeout', { ms: input.timeoutMs }), null);
    }

    let target: ResolvedTarget;
    let parsed: URL;
    try {
      // Each hop is resolved and checked again: a public URL that redirects to
      // 169.254.169.254 stops here.
      const resolved = await resolveUrlGuarded(current, input.allowlist);
      target = resolved.target;
      parsed = resolved.parsed;
      address = target.address;
    } catch (error) {
      const blocked = error instanceof SsrfBlockedError;
      const reason = messageOf(error, language);
      return fail(
        blocked ? 'blocked' : 'network',
        blocked && redirects > 0 ? say('fetch.redirectRefused', { reason }) : reason,
        null,
      );
    }

    if (input.requireHttps === true && parsed.protocol !== 'https:') {
      const reason = say('fetch.notHttps', { url: current });
      return fail(
        'blocked',
        redirects > 0 ? say('fetch.redirectRefused', { reason }) : reason,
        null,
      );
    }

    let hop: HopResponse;
    try {
      hop = await requestOnce({
        url: parsed,
        target,
        method: input.method,
        timeoutMs: Math.max(1, deadline - Date.now()),
        maxBytes: input.maxBytes,
        readBody: input.readBody,
        accept,
      });
    } catch (error) {
      return fail('network', messageOf(error, language), null);
    }

    latencyMs += hop.headersAtMs;
    const location = hop.headers.location;

    if (REDIRECT_CODES.has(hop.status) && typeof location === 'string' && location !== '') {
      if (redirects >= maxRedirects) {
        return fail('redirect', say('fetch.tooManyRedirects', { max: maxRedirects }), hop.status);
      }
      try {
        current = new URL(location, current).toString();
      } catch {
        return fail('redirect', say('fetch.badRedirect', { location }), hop.status);
      }
      redirects += 1;
      continue;
    }

    return {
      ok: true,
      status: hop.status,
      headers: hop.headers,
      body: hop.body,
      truncated: hop.truncated,
      latencyMs,
      redirects,
      address: target.address,
      finalUrl: current,
      certificate: hop.certificate,
    };
  }
}

const MS_PER_DAY = 86_400_000;

/**
 * An HTTP probe's certificate measurements: days left and end date. Empty when
 * the page is served in clear. Informative only: it is the "TLS certificate"
 * probe that carries the notice period and turns it into an incident.
 */
export function certificateMetrics(
  certificate: PeerCertificateSummary | null,
  now: number = Date.now(),
): { certDaysRemaining?: number; certValidTo?: string } {
  if (!certificate) return {};
  // Rounded down, like the TLS probe: "0 days" on the day of expiry.
  const days = Math.floor((Date.parse(certificate.validTo) - now) / MS_PER_DAY);
  return { certDaysRemaining: days, certValidTo: certificate.validTo };
}

/**
 * Decodes a response body according to the character set the server announces.
 *
 * Assuming UTF-8 everywhere is a silent source of false negatives: a French site
 * still served as `windows-1252` would make "Connecté" unreadable, and the probe
 * would cry outage over an accent. We therefore read the `content-type` label;
 * if it is missing or unknown to the platform, we fall back on lenient UTF-8
 * rather than throw.
 */
export function decodeBody(body: Buffer, contentType: string | undefined): string {
  const label = /charset\s*=\s*"?([\w:.+-]+)"?/i.exec(contentType ?? '')?.[1];
  let text: string;
  try {
    text = new TextDecoder(label ?? 'utf-8').decode(body);
  } catch {
    text = new TextDecoder('utf-8').decode(body);
  }
  // The byte order mark is not content; left at the start, it would fail a
  // keyword located at the very beginning of the document.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
