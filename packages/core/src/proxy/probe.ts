import { exec } from '../ssh/client.js';
import type { RouteCertificate } from './model.js';
import type { ProxyHostContext, ProxyRoute, RouteProbe } from './types.js';

/**
 * La sonde d'une route, commune à tous les proxies qui écoutent sur les ports
 * 80 et 443 de leur machine.
 *
 * Lancée **sur la machine du proxy**, en forçant le nom vers la boucle locale
 * (`--resolve`) : on éprouve le proxy et sa configuration, pas le DNS public —
 * qui peut ne pas encore pointer là, ou passer par un CDN. Le certificat est lu
 * de la même façon, sur le port 443, avec le nom demandé (SNI).
 */

const PROBE_TIMEOUT_MS = 60_000;

/** Ce que Traefik répond quand aucune route ne correspond au nom. */
const NO_ROUTE_BODY = '404 page not found';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function routeProbeScript(route: ProxyRoute, path: string): string {
  const host = shellQuote(route.hostname);
  const target = shellQuote(path.startsWith('/') ? path : `/${path}`);
  return [
    `H=${host}`,
    `P=${target}`,
    'B=$(mktemp)',
    'probe() {',
    `  code=$(curl -s -k -o "$B" -w '%{http_code}' -m 10 --resolve "$H:$2:127.0.0.1" "$1://$H$P" 2>/dev/null) || true`,
    '  [ -n "$code" ] || code=000',
    `  if grep -q ${shellQuote(NO_ROUTE_BODY)} "$B" 2>/dev/null; then nf=1; else nf=0; fi`,
    '  echo "probe $1 $code $nf"',
    '}',
    'probe http 80',
    ...(route.tls
      ? [
          'probe https 443',
          'if command -v openssl >/dev/null 2>&1; then',
          '  echo | openssl s_client -connect 127.0.0.1:443 -servername "$H" 2>/dev/null' +
            ' | openssl x509 -noout -subject -issuer -enddate 2>/dev/null | sed "s/^/cert /"',
          'else',
          '  curl -sk -v -o /dev/null -m 10 --resolve "$H:443:127.0.0.1" "https://$H/" 2>&1' +
            " | sed -n 's/^\\*[[:space:]]*\\(subject\\|issuer\\|expire date\\):[[:space:]]*/curl \\1=/p'",
          'fi',
        ]
      : []),
    'rm -f "$B"',
  ].join('\n');
}

type Probed = { code: number; noRoute: boolean };

function parseProbes(stdout: string): Record<'http' | 'https', Probed | undefined> {
  const result: Record<'http' | 'https', Probed | undefined> = {
    http: undefined,
    https: undefined,
  };
  for (const line of stdout.split('\n')) {
    const match = /^probe (http|https) (\d{3}) ([01])$/.exec(line.trim());
    if (match) {
      result[match[1] as 'http' | 'https'] = { code: Number(match[2]), noRoute: match[3] === '1' };
    }
  }
  return result;
}

/** Le texte d'un champ du certificat, sans le préfixe `CN=` superflu pour l'œil. */
function field(stdout: string, names: string[]): string | null {
  for (const line of stdout.split('\n')) {
    const match = /^(?:cert|curl) ([a-zA-Z ]+?)\s*=\s*(.*)$/.exec(line.trim());
    if (match && names.includes(match[1]!.trim().toLowerCase())) return match[2]!.trim();
  }
  return null;
}

/** `notAfter=Oct  1 12:00:00 2026 GMT` ou `expire date: Oct  1 12:00:00 2026 GMT`. */
function parseDate(value: string | null): string | null {
  if (!value) return null;
  const time = Date.parse(value.replace(/\s+/g, ' '));
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export function parseCertificate(stdout: string, now = Date.now()): RouteCertificate {
  const subject = field(stdout, ['subject']);
  const issuer = field(stdout, ['issuer']);
  const notAfter = parseDate(field(stdout, ['notafter', 'expire date']));
  if (!subject && !issuer) return { status: 'unknown', subject: null, issuer: null, notAfter };
  // Traefik présente ce certificat tant qu'il n'en a pas obtenu un vrai.
  const isDefault = /TRAEFIK DEFAULT CERT/i.test(`${subject ?? ''} ${issuer ?? ''}`);
  const expired = notAfter !== null && Date.parse(notAfter) < now;
  return {
    status: isDefault ? 'pending' : expired ? 'invalid' : 'valid',
    subject,
    issuer,
    notAfter,
  };
}

function judge(name: string, probed: Probed | undefined, redirectExpected: boolean): string | null {
  if (!probed) return `${name} : aucune réponse lisible`;
  const { code, noRoute } = probed;
  if (code === 0) return `${name} : le proxy ne répond pas sur ce port`;
  if (code === 404 && noRoute) return `${name} : le proxy ne connaît pas ce domaine (404)`;
  if (code === 502 || code === 503 || code === 504) {
    return `${name} : le proxy ne joint pas l'application (${code})`;
  }
  if (redirectExpected && ![301, 302, 307, 308].includes(code)) {
    return `${name} : la redirection vers HTTPS manque (${code})`;
  }
  return null;
}

export function interpretRouteProbe(
  route: ProxyRoute,
  stdout: string,
  now = Date.now(),
): RouteProbe {
  const probes = parseProbes(stdout);
  const problems = [
    judge('HTTP', probes.http, route.tls && route.redirectHttps),
    route.tls ? judge('HTTPS', probes.https, false) : null,
  ].filter((problem): problem is string => problem !== null);
  const certificate: RouteCertificate = route.tls
    ? parseCertificate(stdout, now)
    : { status: 'none', subject: null, issuer: null, notAfter: null };
  const codes = [
    probes.http ? `HTTP ${probes.http.code}` : null,
    route.tls && probes.https ? `HTTPS ${probes.https.code}` : null,
  ].filter(Boolean);
  return {
    ok: problems.length === 0,
    http: probes.http?.code ?? null,
    https: route.tls ? (probes.https?.code ?? null) : null,
    detail: problems.length > 0 ? problems.join(' · ') : `répond — ${codes.join(', ')}`,
    certificate,
  };
}

export async function probeRoute(
  ctx: ProxyHostContext,
  route: ProxyRoute,
  path: string,
): Promise<RouteProbe> {
  const result = await exec(ctx.sshSession, routeProbeScript(route, path), {
    timeout: PROBE_TIMEOUT_MS,
  });
  return interpretRouteProbe(route, result.stdout);
}
