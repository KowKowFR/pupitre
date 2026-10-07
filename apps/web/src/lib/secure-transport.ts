/**
 * Did a request reach the panel over HTTPS — or from the machine itself?
 *
 * The MCP endpoint takes an API token at every call, and an agent's token
 * usually carries all its author's permissions: over plain HTTP, anyone on the
 * path reads it and acts in their name. So `/api/mcp` only answers over HTTPS.
 *
 * - **HTTPS** as the client saw it: behind a reverse proxy that terminates TLS
 *   — the machine's Traefik —, the panel receives plain HTTP with
 *   `X-Forwarded-Proto: https`; `Forwarded: proto=https` says the same.
 * - **Loopback** stays allowed: `localhost`, `127.0.0.0/8`, `::1` — development,
 *   and an SSH tunnel (`ssh -L 3000:localhost:3000`), whose traffic is already
 *   encrypted end to end.
 *
 * These headers come from the client, and a client can lie about them — but only
 * to hurt itself: the guard protects the caller's own token, it grants nothing.
 *
 * A pure module, without `server-only`: it is tested without a server.
 */

type RequestLike = { url: string; headers: Pick<Headers, 'get'> };

function first(value: string | null): string | null {
  const head = value?.split(',')[0]?.trim();
  return head ? head : null;
}

function forwardedProto(headers: Pick<Headers, 'get'>): string | null {
  const forwarded = first(headers.get('forwarded'));
  const match = forwarded ? /(?:^|;)\s*proto=("?)([a-z]+)\1/i.exec(forwarded) : null;
  return match?.[2] ?? first(headers.get('x-forwarded-proto'));
}

function hostnameOf(host: string): string {
  const bracketed = /^\[([^\]]+)\]/.exec(host);
  if (bracketed) return bracketed[1]!.toLowerCase();
  // A bare IPv6 address has several colons: no port to strip.
  if ((host.match(/:/g) ?? []).length > 1) return host.toLowerCase();
  return host.replace(/:\d+$/, '').toLowerCase();
}

export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname) ||
    hostname === '::1'
  );
}

/** `https`, `loopback`, or `null` when the request travelled in clear. */
export function secureTransport(request: RequestLike): 'https' | 'loopback' | null {
  const url = new URL(request.url);
  const proto = (forwardedProto(request.headers) ?? url.protocol.replace(/:$/, '')).toLowerCase();
  if (proto === 'https') return 'https';
  const host = first(request.headers.get('x-forwarded-host')) ?? request.headers.get('host') ?? url.host;
  return isLoopbackHost(hostnameOf(host)) ? 'loopback' : null;
}
