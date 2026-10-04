import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import {
  MONITOR_TYPES,
  RDAP_TLD_KNOWLEDGE_DATE,
  domainConfigSchema,
  keywordConfigSchema,
  parseCidrList,
  safeParseMonitorConfig,
  tldOf,
  tldPublishesRdap,
  type DomainConfig,
} from '../src/monitoring.js';
import {
  containsKeyword,
  foldForSearch,
  judgeDomain,
  httpProbe,
  keywordProbe,
  readBootstrap,
  readRdapDomain,
  stripMarkup,
} from '../src/probe/index.js';

/**
 * The two probes added with site monitoring: keyword and domain expiry.
 *
 * Two families of tests, and the separation is deliberate:
 *
 *   • **Without network** — the keyword search, reading a real RDAP response
 *     frozen as a fixture, the judgment. They are pure functions, they must pass
 *     on an unplugged machine and never depend on a third-party registry.
 *   • **On a local server** — the keyword probe's SSRF guard, including at each
 *     redirect hop. It is the only way to *check* that it inherits the guard
 *     rather than claim it.
 */

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

// ─── keyword: the search ──────────────────────────────────────────────────────

test('lenient mode ignores case, accents and spaces', () => {
  const page = 'Bienvenue, veuillez vous  CONNECTER à votre espace';
  assert.equal(containsKeyword(page, 'connecter', 'lenient'), true);
  assert.equal(containsKeyword(page, 'vous connecter', 'lenient'), true, 'double space squashed');
  assert.equal(containsKeyword('Déjà inscrit ?', 'deja inscrit', 'lenient'), true, 'accents folded');
  assert.equal(containsKeyword('Deja inscrit ?', 'déjà inscrit', 'lenient'), true, 'and the other way round');
});

test("the no-break space wakes nobody up at three in the morning", () => {
  // The case that motivates lenient mode: a `&nbsp;` before a French-style ":" is
  // not an outage, and a probe that takes it for one ends up ignored.
  const page = 'Statut : en ligne';
  assert.equal(containsKeyword(page, 'Statut : en ligne', 'lenient'), true);
  assert.equal(containsKeyword(page, 'Statut : en ligne', 'strict'), false);
  // The narrow no-break space, the one of units, is folded too.
  assert.equal(containsKeyword('12 345 comptes', '12 345 comptes', 'lenient'), true);
});

test('strict mode compares character for character', () => {
  assert.equal(containsKeyword('{"status":"ok"}', '"status":"ok"', 'strict'), true);
  assert.equal(containsKeyword('{"status":"OK"}', '"status":"ok"', 'strict'), false);
  assert.equal(containsKeyword('{"status":"OK"}', '"status":"ok"', 'lenient'), true);
});

test('folding is symmetric and idempotent', () => {
  assert.equal(foldForSearch('  ÉTÉ  2026 '), 'ete 2026');
  assert.equal(foldForSearch(foldForSearch('ÉTÉ')), foldForSearch('ÉTÉ'));
});

test('stripping removes what a visitor does not read', () => {
  const html =
    '<!-- TODO: Erreur 500 à corriger -->' +
    '<script>var msg = "Erreur 500";</script>' +
    '<style>.a{content:"Erreur 500"}</style>' +
    '<img alt="Erreur 500"><p>Tout va bien</p>';
  const text = stripMarkup(html);
  assert.equal(containsKeyword(text, 'Erreur 500', 'lenient'), false, 'aucune occurrence visible');
  assert.equal(containsKeyword(text, 'Tout va bien', 'lenient'), true);
  // On the raw response, the four invisible occurrences would wrongly trigger.
  assert.equal(containsKeyword(html, 'Erreur 500', 'lenient'), true);
});

test('stripping renders entities and does not glue words together', () => {
  assert.equal(foldForSearch(stripMarkup('<b>Se</b><i>connecter</i>')), 'se connecter');
  assert.equal(stripMarkup('<p>Caf&eacute; &amp; th&#233;</p>').includes('&'), true);
  assert.equal(containsKeyword(stripMarkup('<p>Caf&#233; &amp; th&#233;</p>'), 'café & thé', 'lenient'), true);
});

// ─── keyword: the configuration ───────────────────────────────────────────────

test('a keyword probe without a keyword is refused', () => {
  const empty = keywordConfigSchema.safeParse({ url: 'https://exemple.fr/' });
  assert.equal(empty.success, false);
  assert.match(
    empty.success ? '' : (empty.error.issues[0]?.message ?? ''),
    /au moins/,
    'le message doit dire quoi remplir',
  );
});

test('presence only, absence only, or both', () => {
  assert.equal(
    keywordConfigSchema.safeParse({ url: 'https://exemple.fr/', mustContain: 'Se connecter' })
      .success,
    true,
  );
  assert.equal(
    keywordConfigSchema.safeParse({ url: 'https://exemple.fr/', mustNotContain: 'Erreur 500' })
      .success,
    true,
  );
  const both = keywordConfigSchema.safeParse({
    url: 'https://exemple.fr/',
    mustContain: 'Se connecter',
    mustNotContain: 'Erreur 500',
  });
  assert.equal(both.success, true);
  assert.equal(both.success && both.data.matching, 'lenient', 'lenient by default');
  assert.equal(both.success && both.data.scope, 'raw', 'raw by default');
  assert.equal(both.success && both.data.maxKib, 512);
});

test('the read cap is bounded on both sides', () => {
  const base = { url: 'https://exemple.fr/', mustContain: 'x' };
  assert.equal(keywordConfigSchema.safeParse({ ...base, maxKib: 8 }).success, false, 'trop bas');
  assert.equal(keywordConfigSchema.safeParse({ ...base, maxKib: 4096 }).success, false, 'trop haut');
  assert.equal(keywordConfigSchema.safeParse({ ...base, maxKib: 16 }).success, true);
  assert.equal(keywordConfigSchema.safeParse({ ...base, maxKib: 2048 }).success, true);
});

test('the SSRF guard applies to the keyword configuration as to the others', () => {
  assert.equal(safeParseMonitorConfig('keyword', { url: 'http://localhost:3000/', mustContain: 'x' }).ok, false);
  assert.equal(safeParseMonitorConfig('keyword', { url: 'file:///etc/passwd', mustContain: 'x' }).ok, false);
  assert.equal(
    safeParseMonitorConfig('keyword', { url: 'https://admin:secret@exemple.fr/', mustContain: 'x' }).ok,
    false,
  );
});

// ─── keyword: the probe, against a local server ───────────────────────────────

/**
 * The test server is on 127.0.0.1, and the probe only reaches it because the
 * test explicitly opens `127.0.0.0/8` in the allow list — which is already a
 * demonstration: without that line, nothing gets through.
 */
const LOOPBACK = parseCidrList('127.0.0.0/8');
const servers: Server[] = [];

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

after(() => {
  for (const server of servers) server.close();
});

test('the probe finds an accented keyword on a page served as windows-1252', async () => {
  // Assuming UTF-8 everywhere would fail "Connecté" on a French site still served
  // as latin-1 — a false outage over an accent.
  const body = Buffer.from('<p>Utilisateur Connect\xe9</p>', 'latin1');
  const url = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=windows-1252' });
    res.end(body);
  });

  const result = await keywordProbe.run(
    { url: `${url}/`, mustContain: 'utilisateur connecte' },
    { allowlist: LOOPBACK, language: 'fr' },
  );
  assert.equal(result.outcome, 'healthy', result.detail ?? '');
  assert.equal(result.metrics.httpStatus, 200);
  assert.equal(result.metrics.truncated, 'non');
});

test('a forbidden text present fails the probe, and says so', async () => {
  const url = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<h1>Erreur 500</h1><p>Une erreur est survenue</p>');
  });

  const result = await keywordProbe.run(
    { url: `${url}/`, mustNotContain: 'Erreur 500' },
    { allowlist: LOOPBACK, language: 'fr' },
  );
  assert.equal(result.outcome, 'unhealthy');
  assert.match(result.detail ?? '', /texte interdit/);
  assert.equal(result.metrics.httpStatus, 200, 'a 200: it is indeed the keyword that decided');
});

test('a truncation never passes itself off as an absence', async () => {
  // The keyword is beyond the read cap: the probe fails — it cannot prove
  // presence — but the sentence says it cut.
  const url = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`${'a'.repeat(64 * 1024)}Se connecter`);
  });

  const result = await keywordProbe.run(
    { url: `${url}/`, mustContain: 'Se connecter', maxKib: 16 },
    { allowlist: LOOPBACK, language: 'fr' },
  );
  assert.equal(result.outcome, 'unhealthy');
  assert.match(result.detail ?? '', /réponse coupée à 16 kio/);
  assert.equal(result.metrics.truncated, 'oui');
  assert.equal(result.metrics.bytesRead, 16 * 1024);
});

test('a “healthy” on a cut response says what it could not check', async () => {
  const url = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Se connecter'.padEnd(64 * 1024, ' '));
  });

  const result = await keywordProbe.run(
    { url: `${url}/`, mustContain: 'Se connecter', mustNotContain: 'Erreur 500', maxKib: 16 },
    { allowlist: LOOPBACK, language: 'fr' },
  );
  assert.equal(result.outcome, 'healthy');
  assert.match(result.detail ?? '', /16 premiers kio seulement/);
});

test('the keyword probe inherits the SSRF guard at each redirect', async () => {
  // The point that matters: checking the starting address is not enough. An
  // allowed URL that returns a 302 to the metadata service must stop at the
  // second hop, not the first.
  const url = await serve((_req, res) => {
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
    res.end();
  });

  const result = await keywordProbe.run(
    { url: `${url}/`, mustContain: 'peu importe' },
    { allowlist: LOOPBACK, language: 'fr' },
  );
  assert.equal(result.outcome, 'unreachable');
  assert.match(result.detail ?? '', /redirection refusée/);
  assert.match(result.detail ?? '', /aucune liste/, 'link-local is never allowed');
});

test('a redirect to a range not allowed is refused too', async () => {
  const url = await serve((_req, res) => {
    res.writeHead(301, { location: 'http://10.11.12.13/interne' });
    res.end();
  });

  const result = await keywordProbe.run(
    { url: `${url}/`, mustContain: 'peu importe' },
    { allowlist: LOOPBACK, language: 'fr' },
  );
  assert.equal(result.outcome, 'unreachable');
  assert.match(result.detail ?? '', /redirection refusée/);
  assert.match(result.detail ?? '', /MONITOR_ALLOWED_CIDRS/);
});

test('without an allowed range, the probe does not even reach the local server', async () => {
  const url = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Se connecter');
  });

  const result = await keywordProbe.run(
    { url: `${url}/`, mustContain: 'Se connecter' },
    { allowlist: [], language: 'fr' },
  );
  assert.equal(result.outcome, 'unreachable');
  assert.match(result.detail ?? '', /bouclage|de bouclage/);
});

test('the expected code is checked before the keyword', async () => {
  // A 404 page may very well contain the expected word.
  const url = await serve((_req, res) => {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<p>Se connecter</p>');
  });

  const result = await keywordProbe.run(
    { url: `${url}/`, mustContain: 'Se connecter' },
    { allowlist: LOOPBACK, language: 'fr' },
  );
  assert.equal(result.outcome, 'unhealthy');
  assert.match(result.detail ?? '', /code 404/);
});

// ─── domaine : quels TLD ont un RDAP ──────────────────────────────────────────

test('the knowledge of TLDs is dated, so that we know when it ages', () => {
  assert.match(RDAP_TLD_KNOWLEDGE_DATE, /^\d{4}-\d{2}-\d{2}$/);
});

test('TLDs without RDAP are known as such', () => {
  // Measured on IANA's files: 1,200 TLDs out of 1,438 publish an RDAP.
  for (const tld of ['io', 'de', 'co', 'eu', 'ch', 'it', 'es', 'be', 'us', 'jp']) {
    assert.equal(tldPublishesRdap(tld), false, `.${tld} n'a pas de RDAP`);
  }
  for (const tld of ['arpa', 'edu', 'mil']) {
    assert.equal(tldPublishesRdap(tld), false, `.${tld} is a role TLD`);
  }
});

test('the listed gTLDs and ccTLDs have one, IDNs are not decided', () => {
  for (const tld of ['com', 'net', 'org', 'dev', 'app', 'solutions', 'fr', 'nl', 'uk', 'ca']) {
    assert.equal(tldPublishesRdap(tld), true, `.${tld} publie un RDAP`);
  }
  assert.equal(tldPublishesRdap('xn--p1ai'), null, 'we never block on ignorance');
});

test('a domain on a TLD without RDAP is refused at creation, with the reason', () => {
  const refused = domainConfigSchema.safeParse({ domain: 'exemple.io' });
  assert.equal(refused.success, false);
  const message = refused.success ? '' : (refused.error.issues[0]?.message ?? '');
  assert.match(message, /\.io/);
  assert.match(message, /RDAP/, 'the reason must be readable without reading the code');
  // Refusing right away is better than a permanent red light: the absence of an
  // RDAP service is not an outage of the domain.
  assert.equal(domainConfigSchema.safeParse({ domain: 'exemple.fr' }).success, true);
  assert.equal(domainConfigSchema.safeParse({ domain: 'exemple.com' }).success, true);
});

test('the domain probe wants a domain name, not a URL', () => {
  for (const bad of [
    'https://exemple.fr',
    'exemple.fr/chemin',
    'exemple.fr:443',
    'exemple',
    'localhost',
    '192.168.1.1',
    'exemple..fr',
    '-exemple.fr',
  ]) {
    assert.equal(domainConfigSchema.safeParse({ domain: bad }).success, false, `“${bad}” accepted`);
  }
});

test('the name is normalized without being rewritten', () => {
  const parsed = domainConfigSchema.parse({ domain: '  Exemple.FR.  ' });
  assert.equal(parsed.domain, 'exemple.fr', 'case and trailing dot normalized');
  // `www.` is not removed: guessing the registrable domain would require the
  // Public Suffix List, and an invisible correction hides an input error.
  assert.equal(domainConfigSchema.parse({ domain: 'www.exemple.fr' }).domain, 'www.exemple.fr');
  assert.equal(tldOf('sous.exemple.fr'), 'fr');
});

// ─── domain: the bootstrap list ───────────────────────────────────────────────

test('IANA’s bootstrap list reads as it is published', () => {
  const map = readBootstrap(fixture('iana-rdap-bootstrap-slice.json'));
  assert.equal(map.get('com'), 'https://rdap.verisign.com/com/v1/');
  assert.equal(map.get('fr'), 'https://rdap.nic.fr/');
  assert.equal(map.get('dev'), 'https://pubapi.registry.google/rdap/');
  assert.equal(map.get('io'), undefined);
});

test('an unreadable bootstrap list returns an empty table, not an exception', () => {
  assert.equal(readBootstrap({ services: 'pas un tableau' }).size, 0);
  assert.equal(readBootstrap(null).size, 0);
  // An entry served in clear is ignored: an RDAP response altered in transit
  // would say anything about an expiry date.
  assert.equal(readBootstrap({ services: [[['zz'], ['http://rdap.example/']]] }).size, 0);
});

// ─── domain: reading a real RDAP response ─────────────────────────────────────

test('a real RDAP response from Verisign reads entirely', () => {
  const facts = readRdapDomain(fixture('rdap-example-com.json'));
  assert.equal(facts.ldhName, 'example.com', '.com uppercases its name, we normalize it');
  assert.equal(facts.expiresOn, '2027-08-13T04:00:00.000Z');
  assert.equal(facts.registeredOn, '1995-08-14T04:00:00.000Z');
  assert.equal(facts.registrar, 'RESERVED-Internet Assigned Numbers Authority');
  assert.deepEqual(facts.nameservers, ['elliott.ns.cloudflare.com', 'hera.ns.cloudflare.com']);
  // "client transfer prohibited" and "clientTransferProhibited" mean the same
  // thing: we flatten both forms.
  assert.ok(facts.statuses.includes('clienttransferprohibited'));
});

test('a real RDAP response from AFNIC reads too, with its particularities', () => {
  const facts = readRdapDomain(fixture('rdap-afnic-fr.json'));
  assert.equal(facts.ldhName, 'afnic.fr');
  assert.equal(facts.expiresOn, '2029-07-18T08:26:59.000Z');
  assert.equal(facts.registrar, 'Registry Operations');
  assert.deepEqual(facts.nameservers, ['g.ext.nic.fr', 'ns1.nic.fr', 'ns2.nic.fr', 'ns3.nic.fr']);
  // The particularity that matters: AFNIC only announces "active". Requiring the
  // transfer lock on a .fr would therefore fail, hence the "off" default.
  assert.deepEqual(facts.statuses, ['active']);
});

test('a malformed response does not bring the reading down', () => {
  const facts = readRdapDomain({ objectClassName: 'domain' });
  assert.equal(facts.expiresOn, null);
  assert.deepEqual(facts.nameservers, []);
  assert.equal(readRdapDomain('pas du JSON RDAP').registrar, null);
});

// ─── domaine : le jugement ────────────────────────────────────────────────────

const NOW = new Date('2026-09-13T12:00:00Z');
const baseConfig = (over: Partial<DomainConfig> = {}): DomainConfig =>
  domainConfigSchema.parse({ domain: 'exemple.fr', ...over });

test('a domain far from its expiry is healthy and silent', () => {
  const facts = readRdapDomain(fixture('rdap-afnic-fr.json'));
  const verdict = judgeDomain(facts, baseConfig(), NOW);
  assert.equal(verdict.outcome, 'healthy');
  assert.equal(verdict.detail, null);
  assert.equal(verdict.daysRemaining, 1038);
});

test('within the notice period, the probe fails — and the sentence says “at risk”, not “down”', () => {
  const facts = readRdapDomain({
    events: [{ eventAction: 'expiration', eventDate: '2026-09-25T00:00:00Z' }],
  });
  const verdict = judgeDomain(facts, baseConfig({ warnDays: 30 }), NOW);
  assert.equal(verdict.outcome, 'unhealthy');
  assert.equal(verdict.daysRemaining, 11);
  assert.match(verdict.detail ?? '', /expire dans 11 jours \(le 25\/09\/2026\)/);
  assert.match(verdict.detail ?? '', /préavis de 30 jours/);
  // A shorter notice period leaves the same domain healthy: it is a setting, not
  // a property of the domain.
  assert.equal(judgeDomain(facts, baseConfig({ warnDays: 7 }), NOW).outcome, 'healthy');
});

test('an expired domain is counted in elapsed days', () => {
  const facts = readRdapDomain({
    events: [{ eventAction: 'expiration', eventDate: '2026-09-01T00:00:00Z' }],
  });
  const verdict = judgeDomain(facts, baseConfig(), NOW);
  assert.equal(verdict.outcome, 'unhealthy');
  assert.match(verdict.detail ?? '', /expiré depuis 13 jours/);
});

test('a registry without an expiry date does not make the probe sick', () => {
  // The registry answered and knows the domain: it *is* registered. Not
  // publishing a date is a limit of that registry, not an outage — but we say
  // so, otherwise we would suggest we monitor the expiry.
  const verdict = judgeDomain(readRdapDomain({ status: ['active'] }), baseConfig(), NOW);
  assert.equal(verdict.outcome, 'healthy');
  assert.equal(verdict.daysRemaining, null);
  assert.match(verdict.detail ?? '', /ne publie pas de date d’expiration/);
});

test('a registrar change fails the probe — that is what it is for', () => {
  const facts = readRdapDomain(fixture('rdap-example-com.json'));
  assert.equal(judgeDomain(facts, baseConfig({ expectedRegistrar: 'Internet Assigned' }), NOW).outcome, 'healthy');
  // Tolerant comparison: "OVH" must recognize "OVH SAS".
  assert.equal(
    judgeDomain(
      readRdapDomain({ entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', 'OVH SAS']]] }] }),
      baseConfig({ expectedRegistrar: 'ovh' }),
      NOW,
    ).outcome,
    'healthy',
  );
  const hijacked = judgeDomain(facts, baseConfig({ expectedRegistrar: 'OVH' }), NOW);
  assert.equal(hijacked.outcome, 'unhealthy');
  assert.match(hijacked.detail ?? '', /transfert de domaine/);
});

test('a move of the name servers shows', () => {
  const facts = readRdapDomain(fixture('rdap-example-com.json'));
  assert.equal(
    judgeDomain(facts, baseConfig({ expectedNameserverSuffix: 'cloudflare.com' }), NOW).outcome,
    'healthy',
  );
  const moved = judgeDomain(facts, baseConfig({ expectedNameserverSuffix: 'ovh.net' }), NOW);
  assert.equal(moved.outcome, 'unhealthy');
  assert.match(moved.detail ?? '', /délégation actuelle : elliott\.ns\.cloudflare\.com/);
});

test('the transfer lock is only required if asked for', () => {
  const afnic = readRdapDomain(fixture('rdap-afnic-fr.json'));
  assert.equal(judgeDomain(afnic, baseConfig(), NOW).outcome, 'healthy', 'off by default');
  const required = judgeDomain(afnic, baseConfig({ transferLock: 'required' }), NOW);
  assert.equal(required.outcome, 'unhealthy', '.fr only announces “active”');
  assert.match(required.detail ?? '', /statuts : active/);

  const verisign = readRdapDomain(fixture('rdap-example-com.json'));
  assert.equal(judgeDomain(verisign, baseConfig({ transferLock: 'required' }), NOW).outcome, 'healthy');
});

test('several findings are told together, not just one', () => {
  // An expiry close by *and* a changed registrar: returning only one would make
  // the other disappear from the alert message, and the second is the more
  // serious.
  const facts = readRdapDomain({
    events: [{ eventAction: 'expiration', eventDate: '2026-09-20T00:00:00Z' }],
    entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', 'Registrar Inconnu']]] }],
  });
  const verdict = judgeDomain(facts, baseConfig({ expectedRegistrar: 'OVH' }), NOW);
  assert.equal(verdict.outcome, 'unhealthy');
  assert.match(verdict.detail ?? '', /expire dans 6 jours/);
  assert.match(verdict.detail ?? '', /Registrar Inconnu/);
});

// ─── the HTTP probe, after extracting the guarded loop ────────────────────────

/**
 * The request loop moved to `probe/fetch.ts`, shared by HTTP, keyword and RDAP.
 * These three tests freeze the HTTP probe's behavior so that the extraction
 * stays an extraction, and not a disguised change.
 */

test('the HTTP probe still returns code, latency and address', async () => {
  const url = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('bonjour');
  });
  const result = await httpProbe.run({ url: `${url}/` }, { allowlist: LOOPBACK, language: 'fr' });
  assert.equal(result.outcome, 'healthy');
  assert.equal(result.metrics.httpStatus, 200);
  assert.equal(result.metrics.redirects, 0);
  assert.equal(result.metrics.address, '127.0.0.1');
});

test('a redirect loop is “answers badly”, not “unreachable”', async () => {
  const url = await serve((_req, res) => {
    res.writeHead(302, { location: '/encore' });
    res.end();
  });
  const result = await httpProbe.run({ url: `${url}/` }, { allowlist: LOOPBACK, language: 'fr' });
  assert.equal(result.outcome, 'unhealthy', 'the target answered — badly');
  assert.match(result.detail ?? '', /plus de 5 redirections/);
  assert.equal(result.metrics.httpStatus, 302);
  assert.equal(result.metrics.redirects, 5);
});

test("the HTTP probe's keyword option stays an exact substring", async () => {
  const url = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<p>Se Connecter</p>');
  });
  // Deliberately intolerant: it is the `keyword` type that folds case.
  const strict = await httpProbe.run(
    { url: `${url}/`, keyword: 'se connecter' },
    { allowlist: LOOPBACK, language: 'fr' },
  );
  assert.equal(strict.outcome, 'unhealthy');
  const exact = await httpProbe.run(
    { url: `${url}/`, keyword: 'Se Connecter' },
    { allowlist: LOOPBACK, language: 'fr' },
  );
  assert.equal(exact.outcome, 'healthy');
});

// ─── cadence ──────────────────────────────────────────────────────────────────

test('a registry is not queried more than once every six hours', () => {
  // A registry is a free public service, and a domain does not expire between two
  // minutes: the minimum interval is a property of the type.
  assert.equal(MONITOR_TYPES.domain.minIntervalSeconds, 6 * 3_600);
  assert.equal(MONITOR_TYPES.domain.defaultIntervalSeconds, 86_400);
  // The keyword is the same request as HTTP with a bit of reading.
  assert.equal(MONITOR_TYPES.keyword.minIntervalSeconds, MONITOR_TYPES.http.minIntervalSeconds);
});

// ─── certificate as seen by the HTTP probes ───────────────────────────────────

test('certificate: days left rounded down, and nothing for a page in clear', async () => {
  const { certificateMetrics } = await import('../src/probe/fetch.js');
  const now = Date.parse('2026-09-30T12:00:00Z');
  assert.deepEqual(certificateMetrics({ validTo: '2026-12-01T11:00:00.000Z' }, now), {
    certDaysRemaining: 61,
    certValidTo: '2026-12-01T11:00:00.000Z',
  });
  assert.equal(
    certificateMetrics({ validTo: '2026-09-30T18:00:00.000Z' }, now).certDaysRemaining,
    0,
  );
  assert.deepEqual(certificateMetrics(null, now), {});
});

test('certificate: the HTTP and keyword probes declare its two measurements', () => {
  for (const type of ['http', 'keyword'] as const) {
    const keys = MONITOR_TYPES[type].metrics.map((metric) => metric.key);
    assert.ok(keys.includes('certDaysRemaining'), `${type} : jours restants absents`);
    assert.ok(keys.includes('certValidTo'), `${type} : date de fin absente`);
  }
});
