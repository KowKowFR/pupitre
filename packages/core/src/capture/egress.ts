import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import type { Cidr } from '../monitors/ssrf.js';
import { SsrfBlockedError, resolveGuarded } from '../probe/net.js';

/**
 * **The capture browser's egress proxy.**
 *
 * ── Why it exists: an assumption that turned out wrong ──────────────────────
 * The initial intent was purely topological: put the browser on a Compose
 * network of its own, without a route to the stack, and consider the matter
 * closed. A network without a route cannot be forgotten, whereas an application
 * guard in the browser can — the reasoning was good.
 *
 * **It was measured, and it is wrong.** On Docker Engine 29 / Docker Desktop,
 * two distinct `bridge` networks of the same project are not isolated from each
 * other: from the `capture` network, a container reaches `postgres`, `redis` and
 * `panel` by their IP address. The name no longer resolves — that is all the
 * separate network brings — and guessing `172.x.0.4` is no obstacle.
 *
 * What really isolates, and was measured too: **`internal: true`**. An internal
 * network has no gateway at all; the container's routing table fits in one
 * line, that of its own /16. Nothing else is *routable*, neither the stack, nor
 * the host, nor the Internet.
 *
 * But then the browser can no longer capture anything. Hence this proxy: the
 * browser is locked on an internal network where **the only reachable thing is
 * the worker**, and it is started with `--proxy-server` pointing at it. Every
 * exit — main page, redirects, sub-resources, requests made by the page's
 * JavaScript — goes through here, and through the SSRF guard already written.
 *
 * ── What it guarantees, and why it is stronger than the intent ──────────────
 * A hostile page cannot bypass its browser's proxy configuration: the web
 * platform offers no raw socket. And if someone removed the `--proxy-server`
 * option one day, the browser would not lose its guard — it would lose the
 * Internet, and the failure would be immediate and visible. That is the
 * property we were after: **a guard that cannot be silently forgotten.**
 *
 * ── What it does not guarantee ──────────────────────────────────────────────
 * The proxy filters **addresses**, not content. A hostile public page remains
 * free to make the worker send requests to other public addresses — exactly
 * what the HTTP probe already does, and exactly what `MONITOR_ALLOWED_CIDRS`
 * bounds. There is no new power here, there is the same one, applied to the
 * browser.
 *
 * And this proxy is **not** a proxy to open to the world: it listens on the
 * worker's Compose networks, never on the host, and does not start when capture
 * is off.
 */

export type CaptureEgressOptions = {
  allowlist: readonly Cidr[];
  port: number;
  /** Listening interface. `0.0.0.0`: the browser is on another network. */
  host?: string;
  /** Logging of refusals. The worker plugs Pino into it. */
  onBlocked?: (target: string, reason: string) => void;
};

export type CaptureEgress = {
  server: Server;
  port: number;
  close: () => Promise<void>;
};

/** `host:port` of a CONNECT request, or of an absolute URL. */
function splitAuthority(authority: string, fallbackPort: number): { host: string; port: number } {
  const trimmed = authority.trim();
  // Literal IPv6: `[::1]:443`.
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end > 0) {
      const host = trimmed.slice(1, end);
      const rest = trimmed.slice(end + 1);
      const port = rest.startsWith(':') ? Number(rest.slice(1)) : fallbackPort;
      return { host, port: Number.isFinite(port) && port > 0 ? port : fallbackPort };
    }
  }
  const colon = trimmed.lastIndexOf(':');
  if (colon < 0) return { host: trimmed, port: fallbackPort };
  const port = Number(trimmed.slice(colon + 1));
  return {
    host: trimmed.slice(0, colon),
    port: Number.isFinite(port) && port > 0 ? port : fallbackPort,
  };
}

/**
 * Hop-by-hop headers: they describe the connection to the proxy, not the
 * request. Forwarding them breaks keep-alive and leaks our existence.
 */
const HOP_BY_HOP = new Set([
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function createCaptureEgress(options: CaptureEgressOptions): Promise<CaptureEgress> {
  const { allowlist } = options;

  const refuse = (target: string, reason: string): void => {
    options.onBlocked?.(target, reason);
  };

  /**
   * The guard, in a single place for both paths (CONNECT and clear-text HTTP). It
   * returns the **literal address**: we connect to what was checked, never to a
   * name we would resolve again — that is what closes DNS rebinding, and it is the
   * same discipline as the probes.
   */
  async function guard(host: string, port: number): Promise<{ address: string } | { error: string }> {
    try {
      const resolved = await resolveGuarded(host, allowlist);
      return { address: resolved.address };
    } catch (error) {
      const reason =
        error instanceof SsrfBlockedError
          ? error.reason
          : error instanceof Error
            ? error.message
            : String(error);
      refuse(`${host}:${port}`, reason);
      return { error: reason };
    }
  }

  const server = createServer();

  // ── clear-text http: the browser sends a request in absolute form ──────────
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      let parsed: URL;
      try {
        parsed = new URL(req.url ?? '');
      } catch {
        res.writeHead(400).end('proxy: absolute URL expected');
        return;
      }
      if (parsed.protocol !== 'http:') {
        res.writeHead(400).end('proxy: plain http only on this path');
        return;
      }
      const port = parsed.port === '' ? 80 : Number(parsed.port);
      const verdict = await guard(parsed.hostname, port);
      if ('error' in verdict) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end(verdict.error);
        return;
      }

      const headers: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (HOP_BY_HOP.has(key.toLowerCase())) continue;
        headers[key] = value;
      }
      // The original `Host` is kept while we connect to the literal address: it is
      // that pair that makes the check useful.
      headers.host = parsed.host;

      const upstream = httpRequest(
        {
          host: verdict.address,
          port,
          method: req.method,
          path: `${parsed.pathname}${parsed.search}`,
          headers,
          setHost: false,
        },
        (upstreamRes) => {
          // Hop-by-hop headers are removed on the way back **too**. Copying them as is let
          // the target's `Connection: keep-alive` overwrite the `Connection: close` asked
          // for by the browser, and the socket stayed open until the guard timeout — six
          // seconds of latency on an already complete response.
          const headers: Record<string, string | string[]> = {};
          for (const [key, value] of Object.entries(upstreamRes.headers)) {
            if (value === undefined) continue;
            if (HOP_BY_HOP.has(key.toLowerCase())) continue;
            headers[key] = value;
          }
          res.writeHead(upstreamRes.statusCode ?? 502, headers);
          upstreamRes.pipe(res);
        },
      );
      upstream.on('error', (error) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`proxy: ${error.message}`);
      });
      req.pipe(upstream);
    })();
  });

  // ── https: a tunnel, without decryption ────────────────────────────────────
  // We only see `host:port`, which is enough to check the address. Not
  // decrypting is deliberate: a capture must see exactly the same page, with the
  // same certificate, as a visitor — a proxy that steps in would skew the
  // rendering and hide precisely the certificate failures.
  server.on('connect', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    void (async () => {
      const { host, port } = splitAuthority(req.url ?? '', 443);
      const verdict = await guard(host, port);
      if ('error' in verdict) {
        clientSocket.end(`HTTP/1.1 403 Forbidden\r\n\r\n${verdict.error}`);
        return;
      }
      const upstream = netConnect({ host: verdict.address, port }, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      const drop = (): void => {
        upstream.destroy();
        clientSocket.destroy();
      };
      upstream.on('error', drop);
      clientSocket.on('error', drop);
    })();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '0.0.0.0', () => {
      server.removeListener('error', reject);
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : options.port;
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            // Open tunnels do not close by themselves: without this, a worker shutdown would
            // wait for the end of a page still loading.
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
