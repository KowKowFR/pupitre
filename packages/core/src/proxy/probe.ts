import { exec } from '../ssh/client.js';
import type { RouteCertificate } from './model.js';
import type { ProxyHostContext, ProxyRoute, RouteProbe } from './types.js';
import { shellQuote } from '../shell.js';
import type { UiLanguage } from '../i18n.js';
import { proxySay, type ProxySay } from './messages.js';

/**
 * A route's probe, shared by every proxy listening on ports 80 and 443 of its
 * machine.
 *
 * Run **on the proxy's machine**, forcing the name to loopback (`--resolve`): we
 * test the proxy and its configuration, not the public DNS — which may not point
 * there yet, or go through a CDN. The certificate is read the same way, on port
 * 443, with the requested name (SNI).
 */

const PROBE_TIMEOUT_MS = 60_000;

/**
 * What gives away a proxy that does not know the requested name, or does not
 * have a real certificate yet. Each has its own: Traefik answers 404 with a body
 * of its own, BunkerWeb serves its default page **as a 200**. Without a
 * signature, a missing route would pass for a route that answers.
 */
export type ProbeSignatures = {
  /** An excerpt of the body the proxy returns for a name it does not know. */
  noRouteBody: string;
  /** The certificate it presents until it has obtained a real one. */
  placeholderCertificate: RegExp;
  /**
   * A file on the proxy's machine carrying a header to attach to the probes
   * (`Name: value`) — the one that gets them through a WAF's whitelist. Read by
   * `curl -H @file`: the value appears in no argument.
   */
  headerFile?: string;
};

export function routeProbeScript(
  route: ProxyRoute,
  path: string,
  signatures: ProbeSignatures,
): string {
  const host = shellQuote(route.hostname);
  const target = shellQuote(path.startsWith('/') ? path : `/${path}`);
  return [
    `H=${host}`,
    `P=${target}`,
    'B=$(mktemp)',
    // A header from the machine, if there is one: its value stays in the file.
    `F=${signatures.headerFile ? shellQuote(signatures.headerFile) : "''"}`,
    '[ -n "$F" ] && [ -r "$F" ] || F=/dev/null',
    'probe() {',
    `  code=$(curl -s -k -o "$B" -w '%{http_code}' -m 10 -H "@$F" --resolve "$H:$2:127.0.0.1" "$1://$H$P" 2>/dev/null) || true`,
    '  [ -n "$code" ] || code=000',
    `  if grep -qF ${shellQuote(signatures.noRouteBody)} "$B" 2>/dev/null; then nf=1; else nf=0; fi`,
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

/** What a request through the proxy gave: its code, and whether it does not know the name. */
export type Probed = { code: number; noRoute: boolean };

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

/** The text of a certificate field, without the `CN=` prefix, superfluous to the eye. */
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

export function parseCertificate(
  stdout: string,
  signatures: Pick<ProbeSignatures, 'placeholderCertificate'>,
  now = Date.now(),
): RouteCertificate {
  const subject = field(stdout, ['subject']);
  const issuer = field(stdout, ['issuer']);
  const notAfter = parseDate(field(stdout, ['notafter', 'expire date']));
  if (!subject && !issuer) return { status: 'unknown', subject: null, issuer: null, notAfter };
  // The proxy's placeholder certificate: issuance has not succeeded yet.
  const isDefault = signatures.placeholderCertificate.test(`${subject ?? ''} ${issuer ?? ''}`);
  const expired = notAfter !== null && Date.parse(notAfter) < now;
  return {
    status: isDefault ? 'pending' : expired ? 'invalid' : 'valid',
    subject,
    issuer,
    notAfter,
  };
}

function judge(
  name: string,
  probed: Probed | undefined,
  redirectExpected: boolean,
  say: ProxySay,
): string | null {
  if (!probed) return say('probe.unreadable', { name });
  const { code, noRoute } = probed;
  if (code === 0) return say('probe.silent', { name });
  if (noRoute) return say('probe.unknownDomain', { name, code });
  if (code === 502 || code === 503 || code === 504) {
    return say('probe.upstreamDown', { name, code });
  }
  if (redirectExpected && ![301, 302, 307, 308].includes(code)) {
    return say('probe.noRedirect', { name, code });
  }
  return null;
}

export function interpretRouteProbe(
  route: ProxyRoute,
  stdout: string,
  signatures: ProbeSignatures,
  now = Date.now(),
  language: UiLanguage = 'fr',
): RouteProbe {
  return judgeRouteProbe(
    route,
    {
      ...parseProbes(stdout),
      certificate: route.tls
        ? parseCertificate(stdout, signatures, now)
        : { status: 'none', subject: null, issuer: null, notAfter: null },
    },
    language,
  );
}

/**
 * A probe's verdict, wherever it comes from: from the proxy's machine (the
 * script above), or from the panel for a remote proxy (`probeDirect()`).
 */
export function judgeRouteProbe(
  route: ProxyRoute,
  probes: { http?: Probed | undefined; https?: Probed | undefined; certificate: RouteCertificate },
  language: UiLanguage = 'fr',
): RouteProbe {
  const say = proxySay(language);
  const problems = [
    judge('HTTP', probes.http, route.tls && route.redirectHttps, say),
    route.tls ? judge('HTTPS', probes.https, false, say) : null,
  ].filter((problem): problem is string => problem !== null);
  const certificate: RouteCertificate = route.tls
    ? probes.certificate
    : { status: 'none', subject: null, issuer: null, notAfter: null };
  const codes = [
    probes.http ? `HTTP ${probes.http.code}` : null,
    route.tls && probes.https ? `HTTPS ${probes.https.code}` : null,
  ].filter(Boolean);
  return {
    ok: problems.length === 0,
    http: probes.http?.code ?? null,
    https: route.tls ? (probes.https?.code ?? null) : null,
    detail:
      problems.length > 0 ? problems.join(' · ') : say('probe.ok', { codes: codes.join(', ') }),
    certificate,
  };
}

export async function probeRoute(
  ctx: ProxyHostContext,
  route: ProxyRoute,
  path: string,
  signatures: ProbeSignatures,
): Promise<RouteProbe> {
  const result = await exec(ctx.sshSession, routeProbeScript(route, path, signatures), {
    timeout: PROBE_TIMEOUT_MS,
  });
  return interpretRouteProbe(route, result.stdout, signatures, Date.now(), ctx.language);
}
