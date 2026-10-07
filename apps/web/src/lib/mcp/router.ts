/**
 * Finds the Route Handler behind an API path — `/api/targets/7f…/proxy` →
 * `/api/targets/[id]/proxy`, `{ id: '7f…' }` — with Next's precedence: a static
 * segment wins over a dynamic one, whatever the declaration order.
 * `/api/deployments/purge` is the bulk purge, not the deployment "purge".
 *
 * A pure module, without `server-only`: it is tested without a server.
 */

export type RouteMatch = { pattern: string; params: Record<string, string> };

type Segment = { kind: 'static'; value: string } | { kind: 'param'; name: string };

function segmentsOf(pattern: string): Segment[] {
  return pattern
    .split('/')
    .filter(Boolean)
    .map((part) => {
      const param = /^\[([A-Za-z0-9_]+)\]$/.exec(part);
      return param ? { kind: 'param', name: param[1]! } : { kind: 'static', value: part };
    });
}

export type Router = (pathname: string) => RouteMatch | null;

/**
 * Builds the matcher once. A catch-all (`[...all]`) is not accepted: the only one
 * of the panel is Better Auth's, which an agent has no business reaching.
 */
export function createRouter(patterns: readonly string[]): Router {
  const compiled = patterns.map((pattern) => {
    if (pattern.includes('[...')) throw new Error(`catch-all route not supported: ${pattern}`);
    return { pattern, segments: segmentsOf(pattern) };
  });

  return (pathname) => {
    const parts = pathname.split('/').filter(Boolean);
    let best: { match: RouteMatch; rank: string } | null = null;

    for (const route of compiled) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let rank = '';
      let matches = true;
      for (const [index, segment] of route.segments.entries()) {
        const part = parts[index]!;
        if (segment.kind === 'static') {
          if (segment.value !== part) {
            matches = false;
            break;
          }
          rank += '0';
        } else {
          let value: string;
          try {
            value = decodeURIComponent(part);
          } catch {
            matches = false;
            break;
          }
          params[segment.name] = value;
          rank += '1';
        }
      }
      // The lowest rank — static earliest — is the most specific.
      if (matches && (best === null || rank < best.rank)) {
        best = { match: { pattern: route.pattern, params }, rank };
      }
    }
    return best?.match ?? null;
  };
}
