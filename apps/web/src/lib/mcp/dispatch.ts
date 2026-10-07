import 'server-only';
import { ROUTE_MODULES } from './route-table';
import { createRouter } from './router';

/**
 * Calls one of the panel's Route Handlers **in-process**, as if the request had
 * come through HTTP — same token, same caller IP, same browser.
 *
 * This is the MCP endpoint's whole security model: a tool decides nothing. It
 * builds the request the REST API would have received, and the route does the
 * rest — `requirePermission()`, the per-application scope, Zod, `logAudit()`.
 * What an agent can do through MCP is exactly what its token can do through
 * `curl`, no more.
 *
 * Why not a loopback `fetch()`: the panel would have to know the address it
 * listens on from the inside (container, port, `HOSTNAME`), and each call would
 * pay a TCP round trip to come back into the same process.
 */

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export type QueryValue = string | number | boolean | ReadonlyArray<string | number | boolean>;

export type ApiCall = {
  method: HttpMethod;
  /** `/api/…`, without the query string — or with it, merged with `query`. */
  path: string;
  query?: Record<string, QueryValue | null | undefined>;
  /** Sent as JSON. `undefined`: no body. */
  body?: unknown;
};

export type ApiResponse =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'text'; status: number; contentType: string; body: string }
  | { kind: 'image'; status: number; contentType: string; base64: string }
  | { kind: 'binary'; status: number; contentType: string; bytes: number }
  | { kind: 'stream'; status: number }
  | { kind: 'unknown_route'; status: 404 }
  | { kind: 'method_not_allowed'; status: 405; allowed: HttpMethod[] };

type Handler = (
  request: Request,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

const route = createRouter(Object.keys(ROUTE_MODULES));

/**
 * The headers that travel from the MCP request to the inner one: who calls
 * (`authorization`), from where (the IP headers `clientIp()` reads), with what
 * (`user-agent`, which the audit log records). Never `origin` nor
 * `sec-fetch-site`: the MCP request already passed the cross-site check, the
 * inner one is not a browser's.
 */
const FORWARDED_HEADERS = [
  'authorization',
  'user-agent',
  'x-forwarded-for',
  'x-real-ip',
  'cf-connecting-ip',
  'x-client-ip',
] as const;

/** Images an agent may look at — a probe's reference screenshot. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

function buildUrl(base: string, call: ApiCall): URL {
  const url = new URL(call.path, base);
  for (const [key, value] of Object.entries(call.query ?? {})) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
    else url.searchParams.set(key, String(value));
  }
  return url;
}

export function isApiPath(path: string): boolean {
  return /^\/api(\/|$)/.test(path) && !path.split(/[?#]/)[0]!.split('/').includes('..');
}

export async function callApi(outer: Request, call: ApiCall): Promise<ApiResponse> {
  const url = buildUrl(outer.url, call);
  const match = isApiPath(url.pathname) ? route(url.pathname) : null;
  if (!match) return { kind: 'unknown_route', status: 404 };

  const handlers = ROUTE_MODULES[match.pattern] as Partial<Record<HttpMethod, Handler>>;
  const handler = handlers[call.method];
  if (typeof handler !== 'function') {
    return {
      kind: 'method_not_allowed',
      status: 405,
      allowed: HTTP_METHODS.filter((method) => typeof handlers[method] === 'function'),
    };
  }

  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = outer.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const hasBody = call.body !== undefined && call.method !== 'GET';
  if (hasBody) headers.set('content-type', 'application/json');

  const request = new Request(url, {
    method: call.method,
    headers,
    ...(hasBody ? { body: JSON.stringify(call.body) } : {}),
  });
  const response = await handler(request, { params: Promise.resolve(match.params) });
  return readResponse(response);
}

async function readResponse(response: Response): Promise<ApiResponse> {
  const status = response.status;
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();

  if (contentType.startsWith('text/event-stream')) {
    // A live stream never ends: we hang up rather than wait for it.
    await response.body?.cancel().catch(() => undefined);
    return { kind: 'stream', status };
  }
  if (status === 204 || response.body === null) return { kind: 'json', status, body: null };
  if (contentType.includes('json')) {
    const text = await response.text();
    try {
      return { kind: 'json', status, body: text.length === 0 ? null : JSON.parse(text) };
    } catch {
      // `application/x-ndjson`, a JSONL export: one object per line.
      return { kind: 'text', status, contentType, body: text };
    }
  }
  if (contentType.startsWith('text/') || contentType.includes('yaml') || contentType.includes('xml')) {
    return { kind: 'text', status, contentType, body: await response.text() };
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (contentType.startsWith('image/') && bytes.byteLength <= MAX_IMAGE_BYTES) {
    return { kind: 'image', status, contentType, base64: bytes.toString('base64') };
  }
  return { kind: 'binary', status, contentType, bytes: bytes.byteLength };
}
