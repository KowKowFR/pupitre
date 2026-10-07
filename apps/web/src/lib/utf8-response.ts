/**
 * Says the charset of a text response that does not: `application/json` becomes
 * `application/json; charset=utf-8`.
 *
 * JSON is UTF-8 by definition (RFC 8259), and browsers, `curl` and Node read it
 * so. Windows PowerShell 5.1 does not: without a charset, `Invoke-RestMethod`
 * decodes the body as ISO-8859-1, and every accent of a French message — an
 * error, a deployment log, a documentation chapter through MCP — comes out as
 * `Ã©`. Declaring it costs one header parameter, set in `apiRoute()` for every
 * route.
 *
 * A pure module, without `server-only`: it is tested without a server.
 */

const TEXT_TYPES = /^(?:application\/(?:json|x-ndjson)|text\/[\w.+-]+)\s*$/i;

export function declareUtf8(response: Response): Response {
  const type = response.headers.get('content-type');
  if (type === null || !TEXT_TYPES.test(type)) return response;
  try {
    response.headers.set('content-type', `${type.trim()}; charset=utf-8`);
  } catch {
    // Immutable headers — a response passed through as `fetch()` returned it:
    // left as they are.
  }
  return response;
}
