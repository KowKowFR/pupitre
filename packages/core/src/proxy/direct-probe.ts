import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { RouteCertificate } from './model.js';
import type { UiLanguage } from '../i18n.js';
import { judgeRouteProbe, type Probed, type ProbeSignatures } from './probe.js';
import type { ProxyRoute, RouteProbe } from './types.js';

/**
 * A route's probe **from the panel**, for a proxy Pupitre does not drive over
 * SSH. The same principle as the one in `probe.ts`: we address the proxy itself
 * — the address where it receives visitors —, with the requested name as the
 * `Host` header and SNI. Public DNS does not come into play: we test the proxy
 * and its configuration, not a record's propagation.
 */

/** Where the proxy receives visitors. */
export type ProxyEntrypoint = { host: string; httpPort: number; httpsPort: number };

const REQUEST_TIMEOUT_MS = 10_000;
/** Enough to recognize a proxy's "unknown domain" page. */
const BODY_LIMIT = 64 * 1024;

type Answer = { code: number; body: string; certificate: RouteCertificate | null };

function name(fields: Record<string, string | string[] | undefined> | undefined): string | null {
  if (!fields) return null;
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('+') : value}`);
  return parts.length > 0 ? parts.join(', ') : null;
}

/** The presented certificate, as `parseCertificate()` would return it. */
export function readPeerCertificate(
  socket: TLSSocket,
  signatures: Pick<ProbeSignatures, 'placeholderCertificate'>,
  now = Date.now(),
): RouteCertificate {
  const peer = socket.getPeerCertificate();
  if (!peer || Object.keys(peer).length === 0) {
    return { status: 'unknown', subject: null, issuer: null, notAfter: null };
  }
  const subject = name(peer.subject as unknown as Record<string, string>);
  const issuer = name(peer.issuer as unknown as Record<string, string>);
  const time = Date.parse(peer.valid_to);
  const notAfter = Number.isNaN(time) ? null : new Date(time).toISOString();
  const placeholder = signatures.placeholderCertificate.test(`${subject ?? ''} ${issuer ?? ''}`);
  const expired = notAfter !== null && Date.parse(notAfter) < now;
  return {
    status: placeholder ? 'pending' : expired ? 'invalid' : 'valid',
    subject,
    issuer,
    notAfter,
  };
}

function ask(
  scheme: 'http' | 'https',
  entrypoint: ProxyEntrypoint,
  hostname: string,
  path: string,
  signatures: ProbeSignatures,
): Promise<Answer> {
  return new Promise((resolve) => {
    let certificate: RouteCertificate | null = null;
    const options = {
      host: entrypoint.host,
      port: scheme === 'http' ? entrypoint.httpPort : entrypoint.httpsPort,
      path,
      method: 'GET',
      headers: { Host: hostname, 'User-Agent': 'pupitre-probe', Connection: 'close' },
      timeout: REQUEST_TIMEOUT_MS,
      // The certificate is judged separately: we want the response, even if it is not
      // valid.
      ...(scheme === 'https' ? { servername: hostname, rejectUnauthorized: false } : {}),
    };
    const request = (scheme === 'http' ? http : https).request(options, (response) => {
      if (scheme === 'https') {
        certificate = readPeerCertificate(response.socket as TLSSocket, signatures);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        if (size < BODY_LIMIT) chunks.push(chunk);
        size += chunk.length;
      });
      response.on('end', () =>
        resolve({
          code: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8').slice(0, BODY_LIMIT),
          certificate,
        }),
      );
      response.on('error', () =>
        resolve({ code: response.statusCode ?? 0, body: '', certificate }),
      );
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    // Nothing answered — or the proxy refused the TLS handshake for this name.
    request.on('error', () => resolve({ code: 0, body: '', certificate }));
    request.end();
  });
}

/** An HTTP request through the proxy, for a name: its code (`0`: nothing) and its body. */
export async function requestThrough(
  entrypoint: ProxyEntrypoint,
  hostname: string,
  path: string,
): Promise<{ code: number; body: string }> {
  const answer = await ask('http', entrypoint, hostname, path, {
    noRouteBody: '\u0000',
    placeholderCertificate: /$^/,
  });
  return { code: answer.code, body: answer.body };
}

function probed(answer: Answer, signatures: ProbeSignatures): Probed {
  return { code: answer.code, noRoute: answer.body.includes(signatures.noRouteBody) };
}

export async function probeDirect(
  entrypoint: ProxyEntrypoint,
  route: ProxyRoute,
  path: string,
  signatures: ProbeSignatures,
  language: UiLanguage = 'fr',
): Promise<RouteProbe> {
  const target = path.startsWith('/') ? path : `/${path}`;
  const plain = await ask('http', entrypoint, route.hostname, target, signatures);
  const secure = route.tls
    ? await ask('https', entrypoint, route.hostname, target, signatures)
    : null;
  return judgeRouteProbe(
    route,
    {
      http: probed(plain, signatures),
      https: secure ? probed(secure, signatures) : undefined,
      certificate: secure?.certificate ?? {
        status: 'unknown',
        subject: null,
        issuer: null,
        notAfter: null,
      },
    },
    language,
  );
}

/**
 * Does the proxy receive, where it must? The HTTP code of a name it does not
 * know (`0`: nothing), and whether its HTTPS port opens — without a known name, a
 * proxy may refuse the TLS handshake: we ask for no more.
 */
export async function entrypointAnswers(
  entrypoint: ProxyEntrypoint,
): Promise<{ http: number; httpsOpen: boolean }> {
  const answer = await ask('http', entrypoint, 'pupitre-check.invalid', '/', {
    noRouteBody: '\u0000',
    placeholderCertificate: /$^/,
  });
  const httpsOpen = await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: entrypoint.host, port: entrypoint.httpsPort });
    socket.setTimeout(REQUEST_TIMEOUT_MS);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
  return { http: answer.code, httpsOpen };
}
