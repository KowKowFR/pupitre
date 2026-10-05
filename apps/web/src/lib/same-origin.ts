/**
 * Does a write come from the panel itself?
 *
 * The session cookie is `SameSite=Lax`: a browser does not send it with a form
 * posted from another **site**. But a site is a whole registrable domain:
 * `blog.exemple.fr` and `pupitre.exemple.fr` are one. Yet Pupitre precisely
 * deploys sites, often on subdomains neighboring the panel — a booby-trapped page
 * there, opened by a signed-in administrator, would make them post whatever it
 * wants, cookie included.
 *
 * Every write request from a browser carries the `Origin` header (recent browsers
 * also send it for the same origin), and most often `Sec-Fetch-Site`: we require
 * one or the other to say "the panel". A request that carries neither does not
 * come from a browser — `curl`, a script, the worker — and has no cookie to
 * hijack: it goes through.
 *
 * A pure module, without `server-only`: it is tested without a server.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The reason this request is refused, or `null` if it comes from the panel (or
 * writes nothing). `panelOrigin`: `BETTER_AUTH_URL`'s.
 */
export function foreignWrite(
  request: { method: string; headers: Pick<Headers, 'get'> },
  panelOrigin: string,
): string | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;

  const origin = request.headers.get('origin');
  if (origin !== null) {
    // `null` spelled out: a sandboxed page, a `data:` — never the panel.
    return origin === panelOrigin ? null : `origine ${origin}`;
  }

  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') {
    return `Sec-Fetch-Site ${site}`;
  }
  return null;
}

/** The origin of a base URL (`https://pupitre.example.com/` → `https://pupitre.example.com`). */
export function originOf(url: string): string {
  return new URL(url).origin;
}
