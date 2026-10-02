import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { RouteCertificate } from './model.js';
import { judgeRouteProbe, type Probed, type ProbeSignatures } from './probe.js';
import type { ProxyRoute, RouteProbe } from './types.js';

/**
 * La sonde d'une route **depuis le panel**, pour un proxy que Pupitre ne
 * pilote pas en SSH. Même principe que celle de `probe.ts` : on s'adresse au
 * proxy lui-même — l'adresse où il reçoit les visiteurs —, avec le nom demandé
 * en en-tête `Host` et en SNI. Le DNS public n'intervient pas : on éprouve le
 * proxy et sa configuration, pas la propagation d'un enregistrement.
 */

/** Où le proxy reçoit les visiteurs. */
export type ProxyEntrypoint = { host: string; httpPort: number; httpsPort: number };

const REQUEST_TIMEOUT_MS = 10_000;
/** Assez pour reconnaître la page « domaine inconnu » d'un proxy. */
const BODY_LIMIT = 64 * 1024;

type Answer = { code: number; body: string; certificate: RouteCertificate | null };

function name(fields: Record<string, string | string[] | undefined> | undefined): string | null {
  if (!fields) return null;
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('+') : value}`);
  return parts.length > 0 ? parts.join(', ') : null;
}

/** Le certificat présenté, tel que `parseCertificate()` le rendrait. */
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
      // Le certificat se juge à part : on veut la réponse, même s'il n'est pas bon.
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
    // Rien n'a répondu — ou le proxy a refusé la poignée de main TLS pour ce nom.
    request.on('error', () => resolve({ code: 0, body: '', certificate }));
    request.end();
  });
}

/** Une requête HTTP à travers le proxy, pour un nom : son code (`0` : rien) et son corps. */
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
): Promise<RouteProbe> {
  const target = path.startsWith('/') ? path : `/${path}`;
  const plain = await ask('http', entrypoint, route.hostname, target, signatures);
  const secure = route.tls
    ? await ask('https', entrypoint, route.hostname, target, signatures)
    : null;
  return judgeRouteProbe(route, {
    http: probed(plain, signatures),
    https: secure ? probed(secure, signatures) : undefined,
    certificate: secure?.certificate ?? {
      status: 'unknown',
      subject: null,
      issuer: null,
      notAfter: null,
    },
  });
}

/**
 * Le proxy reçoit-il, là où il le doit ? Le code HTTP d'un nom qu'il ne connaît
 * pas (`0` : rien), et si son port HTTPS s'ouvre — sans nom connu, un proxy
 * peut refuser la poignée de main TLS : on n'en demande pas davantage.
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
