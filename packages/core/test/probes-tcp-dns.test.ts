import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { test } from 'node:test';
import {
  MONITOR_TYPES,
  checkHostname,
  checkMonitorTargetLiterals,
  compareDnsRecords,
  describeDnsComparison,
  dnsComparisonKey,
  joinTxtChunks,
  monitorTypeDefinition,
  nextMonitorState,
  parseCidrList,
  parseExpectedRecords,
  safeParseMonitorConfig,
  validateDnsRecordValue,
  type MonitorOutcome,
  type MonitorState,
} from '../src/monitoring.js';
import { getMonitorProbe } from '../src/probe/index.js';
import { resolveGuarded } from '../src/probe/net.js';

const NOTHING_ALLOWED = parseCidrList(undefined);
const LOOPBACK_ALLOWED = parseCidrList('127.0.0.0/8');

// ─── tcp: the schema ──────────────────────────────────────────────────────────

test('a TCP probe is configured with a host and a port', () => {
  const parsed = safeParseMonitorConfig('tcp', { host: 'exemple.fr', port: 25 });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.config : null, {
    host: 'exemple.fr',
    port: 25,
    expectBanner: null,
    timeoutMs: 10_000,
  });
});

test('an out-of-range port is refused', () => {
  assert.equal(safeParseMonitorConfig('tcp', { host: 'exemple.fr', port: 0 }).ok, false);
  assert.equal(safeParseMonitorConfig('tcp', { host: 'exemple.fr', port: 70_000 }).ok, false);
  assert.equal(safeParseMonitorConfig('tcp', { host: 'exemple.fr', port: 25.5 }).ok, false);
});

test("a TCP configuration is not an HTTP configuration", () => {
  assert.equal(safeParseMonitorConfig('tcp', { url: 'https://exemple.fr/' }).ok, false);
  assert.equal(safeParseMonitorConfig('tcp', { host: 'exemple.fr:25' }).ok, false);
});

// ─── tcp: the SSRF guard, at creation ─────────────────────────────────────────

test('a TCP probe to a metadata service is refused by the schema', () => {
  // Link-local is unlocked by no list: the refusal can therefore fall in the
  // schema, without reading the environment and without resolving anything.
  const parsed = safeParseMonitorConfig('tcp', { host: '169.254.169.254', port: 80 });
  assert.equal(parsed.ok, false);
  assert.match(
    parsed.ok ? '' : parsed.error.issues.map((issue) => issue.message).join(' '),
    /aucune liste/,
  );
});

test('the link-local refusal holds for every type, not only TCP', () => {
  assert.equal(safeParseMonitorConfig('tls', { host: '169.254.169.254' }).ok, false);
  assert.equal(safeParseMonitorConfig('http', { url: 'http://169.254.169.254/latest/' }).ok, false);
  assert.equal(checkHostname('169.254.169.254').allowed, false);
  assert.equal(checkHostname('::ffff:169.254.169.254').allowed, false, 'wrapped form');
  assert.equal(checkHostname('exemple.fr').allowed, true);
});

test('a TCP probe to loopback or a private range is refused at creation', () => {
  for (const host of ['127.0.0.1', '10.0.0.5', '192.168.1.20', '172.16.3.4', '100.64.0.1']) {
    const verdict = checkMonitorTargetLiterals('tcp', { host, port: 5432 }, NOTHING_ALLOWED);
    assert.equal(verdict.allowed, false, `${host} should have been refused`);
    assert.equal(verdict.allowed ? '' : verdict.field, 'host');
  }
});

test("a literal IPv6 target cannot be entered at all in a “host” field", () => {
  // `monitorHostSchema` refuses anything containing ":", bracketed form
  // included. A limitation that predates this work, and a conservative one: no
  // literal IPv6 target can be created, so none bypasses the guard. A DNS
  // resolver, on the other hand, is not a host name and accepts IPv6 — it is
  // checked like the others.
  assert.equal(safeParseMonitorConfig('tcp', { host: '::1', port: 5432 }).ok, false);
  assert.equal(safeParseMonitorConfig('tcp', { host: '[::1]', port: 5432 }).ok, false);
  const verdict = checkMonitorTargetLiterals(
    'dns',
    { name: 'exemple.fr', recordType: 'A', resolver: '::1' },
    NOTHING_ALLOWED,
  );
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.allowed ? '' : verdict.field, 'resolver');
});

test("the same target passes if the operator opened the range", () => {
  const verdict = checkMonitorTargetLiterals(
    'tcp',
    { host: '127.0.0.1', port: 5432 },
    LOOPBACK_ALLOWED,
  );
  assert.equal(verdict.allowed, true, 'MONITOR_ALLOWED_CIDRS is there for that');
});

test('the creation check is derived from the declared fields, without a switch on the type', () => {
  // No `if (type === …)`: it is the catalog's `kind: 'host' | 'url'` that say
  // which fields are connection targets. The existing types therefore benefit
  // too.
  assert.equal(
    checkMonitorTargetLiterals('tls', { host: '10.0.0.5' }, NOTHING_ALLOWED).allowed,
    false,
  );
  assert.equal(
    checkMonitorTargetLiterals('http', { url: 'http://10.0.0.5:8080/' }, NOTHING_ALLOWED).allowed,
    false,
  );
  // A name is not judged here: it is only checked once resolved.
  assert.equal(
    checkMonitorTargetLiterals('tcp', { host: 'exemple.fr', port: 25 }, NOTHING_ALLOWED).allowed,
    true,
  );
});

test("a DNS probe's queried name is not a connection target", () => {
  // We never connect to it: checking it would amount to forbidding monitoring
  // "the A of db.internal is indeed 10.0.0.5", which reaches nothing.
  const verdict = checkMonitorTargetLiterals(
    'dns',
    { name: 'db.interne', recordType: 'A', expected: '10.0.0.5' },
    NOTHING_ALLOWED,
  );
  assert.equal(verdict.allowed, true);
});

test('the declared resolver, on the other hand, is a connection target', () => {
  const verdict = checkMonitorTargetLiterals(
    'dns',
    { name: 'exemple.fr', recordType: 'A', resolver: '10.0.0.53' },
    NOTHING_ALLOWED,
  );
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.allowed ? '' : verdict.field, 'resolver');
  assert.equal(
    checkMonitorTargetLiterals(
      'dns',
      { name: 'exemple.fr', recordType: 'A', resolver: '1.1.1.1' },
      NOTHING_ALLOWED,
    ).allowed,
    true,
  );
});

// ─── tcp: the SSRF guard, at run time ─────────────────────────────────────────

test("a TCP probe to loopback is refused at run time, empty list", async () => {
  const result = await getMonitorProbe('tcp').run(
    { host: '127.0.0.1', port: 5432 },
    { allowlist: NOTHING_ALLOWED, language: 'fr' },
  );
  assert.equal(result.outcome, 'unreachable');
  assert.match(result.detail ?? '', /bouclage/);
  assert.match(result.detail ?? '', /MONITOR_ALLOWED_CIDRS/);
});

test("a TCP probe to a private range is refused at run time", async () => {
  const result = await getMonitorProbe('tcp').run(
    { host: '10.0.0.5', port: 22 },
    { allowlist: NOTHING_ALLOWED, language: 'fr' },
  );
  assert.equal(result.outcome, 'unreachable');
  assert.match(result.detail ?? '', /privée/);
});

test("a TCP probe to the metadata service is refused at run time too", async () => {
  // The schema already refuses it, but a probe may have been created before the
  // guard existed: the second line of defense must hold on its own.
  const viaProbe = await getMonitorProbe('tcp').run(
    { host: '169.254.169.254', port: 80 },
    { allowlist: parseCidrList('0.0.0.0/0'), language: 'fr' },
  );
  assert.equal(viaProbe.outcome, 'unreachable');

  await assert.rejects(
    () => resolveGuarded('169.254.169.254', parseCidrList('0.0.0.0/0')),
    /aucune liste/,
    'even a fully open list does not unlock link-local',
  );
});

test('the guard is not bypassed by a name pointing to loopback', async () => {
  // `localhost` is refused by its name; any other entry pointing to 127.0.0.1
  // falls at the check of resolved addresses.
  const result = await getMonitorProbe('tcp').run(
    { host: 'localhost', port: 5432 },
    { allowlist: parseCidrList('127.0.0.0/8'), language: 'fr' },
  );
  assert.equal(result.outcome, 'unreachable');
  assert.match(result.detail ?? '', /localhost/);
});

// ─── tcp: the measurement, against a real socket ──────────────────────────────

function listen(handler: (socket: import('node:net').Socket) => void): Promise<Server> {
  const server = createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('port introuvable');
  return address.port;
}

test('a listening port is healthy, a closed port is unreachable', async () => {
  const server = await listen(() => {});
  const port = portOf(server);
  try {
    const up = await getMonitorProbe('tcp').run(
      { host: '127.0.0.1', port },
      { allowlist: LOOPBACK_ALLOWED, language: 'fr' },
    );
    assert.equal(up.outcome, 'healthy');
    assert.equal(typeof up.metrics.connectMs, 'number');
    assert.equal(up.metrics.address, '127.0.0.1');
  } finally {
    server.close();
  }

  const down = await getMonitorProbe('tcp').run(
    { host: '127.0.0.1', port },
    { allowlist: LOOPBACK_ALLOWED, language: 'fr' },
  );
  assert.equal(down.outcome, 'unreachable', 'le port vient de fermer');
  assert.match(down.detail ?? '', /ECONNREFUSED/);
});

test('the banner tells “something listens” from “the right service listens”', async () => {
  const server = await listen((socket) => socket.write('220 mail.exemple.fr ESMTP Postfix\r\n'));
  const port = portOf(server);
  try {
    const good = await getMonitorProbe('tcp').run(
      { host: '127.0.0.1', port, expectBanner: '220 ' },
      { allowlist: LOOPBACK_ALLOWED, language: 'fr' },
    );
    assert.equal(good.outcome, 'healthy');
    assert.equal(good.metrics.banner, '220 mail.exemple.fr ESMTP Postfix');

    const insensitive = await getMonitorProbe('tcp').run(
      { host: '127.0.0.1', port, expectBanner: 'esmtp postfix' },
      { allowlist: LOOPBACK_ALLOWED, language: 'fr' },
    );
    assert.equal(insensitive.outcome, 'healthy', 'the banner’s case is set by the protocol');

    const wrong = await getMonitorProbe('tcp').run(
      { host: '127.0.0.1', port, expectBanner: 'SSH-2.0' },
      { allowlist: LOOPBACK_ALLOWED, language: 'fr' },
    );
    assert.equal(wrong.outcome, 'unhealthy', 'the port answers, but not the right service');
    assert.match(wrong.detail ?? '', /SSH-2\.0/);
  } finally {
    server.close();
  }
});

test("a silent service is healthy without an expected banner, failing with one", async () => {
  // PostgreSQL, MySQL, HTTP: the client speaks first. The port accepts, nothing
  // is announced. Both verdicts are right, and they differ.
  const server = await listen(() => {});
  const port = portOf(server);
  try {
    const bare = await getMonitorProbe('tcp').run(
      { host: '127.0.0.1', port },
      { allowlist: LOOPBACK_ALLOWED, language: 'fr' },
    );
    assert.equal(bare.outcome, 'healthy');

    const expecting = await getMonitorProbe('tcp').run(
      { host: '127.0.0.1', port, expectBanner: 'PostgreSQL', timeoutMs: 1_000 },
      { allowlist: LOOPBACK_ALLOWED, language: 'fr' },
    );
    assert.equal(expecting.outcome, 'unhealthy');
    assert.match(expecting.detail ?? '', /rien annoncé/);
    assert.equal(typeof expecting.metrics.connectMs, 'number', 'the connection, though, succeeded');
  } finally {
    server.close();
  }
});

// ─── dns: the schema ──────────────────────────────────────────────────────────

test('a DNS probe is configured with a name and a type', () => {
  const parsed = safeParseMonitorConfig('dns', { name: 'exemple.fr' });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.config : null, {
    name: 'exemple.fr',
    recordType: 'A',
    expected: '',
    match: 'exact',
    resolver: null,
    timeoutMs: 5_000,
  });
});

test("a badly written expected value is refused at input, not every quarter of an hour", () => {
  const bad = safeParseMonitorConfig('dns', {
    name: 'exemple.fr',
    recordType: 'A',
    expected: '203.0.113.999',
  });
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? '' : bad.error.issues[0]?.message ?? '', /IPv4/);

  const mx = safeParseMonitorConfig('dns', {
    name: 'exemple.fr',
    recordType: 'MX',
    expected: 'mail.exemple.fr',
  });
  assert.equal(mx.ok, false, 'an MX without a priority does not compare');
  assert.match(mx.ok ? '' : mx.error.issues[0]?.message ?? '', /priorité/);

  const good = safeParseMonitorConfig('dns', {
    name: 'exemple.fr',
    recordType: 'MX',
    expected: '10 mail.exemple.fr, 20 secours.exemple.fr',
  });
  assert.equal(good.ok, true);
});

test('a resolver is declared by its address, never by its name', () => {
  assert.equal(
    safeParseMonitorConfig('dns', { name: 'exemple.fr', resolver: 'dns.google' }).ok,
    false,
  );
  assert.equal(safeParseMonitorConfig('dns', { name: 'exemple.fr', resolver: '9.9.9.9' }).ok, true);
  assert.equal(
    safeParseMonitorConfig('dns', { name: 'exemple.fr', resolver: '169.254.53.53' }).ok,
    false,
    'a link-local resolver is refused like any other connection target',
  );
});

test('the useful types are offered, SOA and PTR are left out', () => {
  const definition = monitorTypeDefinition('dns');
  const field = definition.fields.find((entry) => entry.key === 'recordType');
  assert.ok(field && field.kind === 'select');
  const offered = field.kind === 'select' ? field.options.map((option) => option.value) : [];
  assert.deepEqual(offered, ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'CAA', 'SRV']);
  assert.equal(offered.includes('SOA'), false, 'the serial number moves at each edit');
  assert.equal(safeParseMonitorConfig('dns', { name: 'exemple.fr', recordType: 'SOA' }).ok, false);
});

// ─── dns: the comparison, where everything happens ────────────────────────────

test("order is not signal — a resolver permutes its answers", () => {
  const comparison = compareDnsRecords({
    type: 'MX',
    expected: ['10 mail1.exemple.fr', '20 mail2.exemple.fr'],
    actual: ['20 mail2.exemple.fr', '10 mail1.exemple.fr'],
    match: 'exact',
  });
  assert.equal(comparison.ok, true, 'a naive comparator would alert at each measurement');
  assert.deepEqual(comparison.missing, []);
  assert.deepEqual(comparison.unexpected, []);
});

test("a name's case is not signal, nor is the trailing dot", () => {
  assert.equal(
    compareDnsRecords({
      type: 'CNAME',
      expected: ['Cible.Exemple.FR'],
      actual: ['cible.exemple.fr.'],
      match: 'exact',
    }).ok,
    true,
  );
  assert.equal(
    compareDnsRecords({
      type: 'NS',
      // Some resolvers mix the case on purpose (0x20 encoding).
      expected: ['ns1.exemple.fr', 'ns2.exemple.fr'],
      actual: ['NS2.ExEmPlE.fr.', 'nS1.exemple.FR.'],
      match: 'exact',
    }).ok,
    true,
  );
});

test("a TXT's case is signal — a DKIM key tells aB from Ab", () => {
  const comparison = compareDnsRecords({
    type: 'TXT',
    expected: ['v=DKIM1; p=MIGfMA0GCSqAb'],
    actual: ['v=DKIM1; p=MIGfMA0GCSqaB'],
    match: 'exact',
  });
  assert.equal(comparison.ok, false, 'folding the case here would create a false equality');
});

test("how an address is written is not signal", () => {
  assert.equal(
    compareDnsRecords({
      type: 'AAAA',
      expected: ['2001:0db8:0000:0000:0000:0000:0000:0001'],
      actual: ['2001:db8::1'],
      match: 'exact',
    }).ok,
    true,
  );
});

test('a missing value is reported, and named', () => {
  const comparison = compareDnsRecords({
    type: 'A',
    expected: ['203.0.113.7', '203.0.113.8'],
    actual: ['203.0.113.7'],
    match: 'exact',
  });
  assert.equal(comparison.ok, false);
  assert.deepEqual(comparison.missing, ['203.0.113.8']);
  assert.deepEqual(comparison.matched, ['203.0.113.7']);
});

test("an added record is an anomaly in “exact”, tolerated in “at least”", () => {
  const input = {
    type: 'A' as const,
    expected: ['203.0.113.7'],
    actual: ['203.0.113.7', '198.51.100.9'],
  };
  const strict = compareDnsRecords({ ...input, match: 'exact' });
  assert.equal(strict.ok, false, "the addition is the signature of a hijack");
  assert.deepEqual(strict.unexpected, ['198.51.100.9']);

  const loose = compareDnsRecords({ ...input, match: 'contains' });
  assert.equal(loose.ok, true);
  assert.deepEqual(loose.unexpected, []);
});

test('the priority is part of the MX — the backup turned primary is an incident', () => {
  const comparison = compareDnsRecords({
    type: 'MX',
    expected: ['10 mail1.exemple.fr', '20 mail2.exemple.fr'],
    actual: ['20 mail1.exemple.fr', '10 mail2.exemple.fr'],
    match: 'exact',
  });
  assert.equal(comparison.ok, false, 'the hosts are the same, the configuration is not');
});

test("a CAA's tag is case-insensitive, like the authority's name", () => {
  assert.equal(
    compareDnsRecords({
      type: 'CAA',
      expected: ['0 issue letsencrypt.org'],
      actual: ['0 ISSUE LetsEncrypt.org'],
      match: 'exact',
    }).ok,
    true,
  );
});

test('an SRV compares on its four fields', () => {
  assert.equal(dnsComparisonKey('SRV', '10 5 5269 XMPP.exemple.fr.'), '10 5 5269 xmpp.exemple.fr');
  assert.equal(
    compareDnsRecords({
      type: 'SRV',
      expected: ['10 5 5269 xmpp.exemple.fr'],
      actual: ['10 5 5222 xmpp.exemple.fr'],
      match: 'exact',
    }).ok,
    false,
    'the port changes where the traffic goes',
  );
});

test('dig’s quoted chunks are glued back together', () => {
  assert.equal(joinTxtChunks('"v=spf1 include:_spf" ".exemple.fr ~all"'), 'v=spf1 include:_spf.exemple.fr ~all');
  assert.equal(joinTxtChunks('v=spf1 ~all'), 'v=spf1 ~all');
  assert.equal(
    compareDnsRecords({
      type: 'TXT',
      expected: ['"v=spf1 include:_spf" ".exemple.fr ~all"'],
      actual: ['v=spf1 include:_spf.exemple.fr ~all'],
      match: 'contains',
    }).ok,
    true,
  );
});

test('the comma separates values, except for TXT where it is data', () => {
  assert.deepEqual(parseExpectedRecords('A', '203.0.113.7, 203.0.113.8'), [
    '203.0.113.7',
    '203.0.113.8',
  ]);
  assert.deepEqual(parseExpectedRecords('TXT', 'v=spf1 ip4:a,ip4:b ~all'), [
    'v=spf1 ip4:a,ip4:b ~all',
  ]);
  assert.deepEqual(parseExpectedRecords('TXT', 'un\ndeux'), ['un', 'deux']);
  // Two spellings of the same value only count once, otherwise an "exactly these
  // values" would become unsatisfiable.
  assert.deepEqual(parseExpectedRecords('NS', 'ns1.exemple.fr, NS1.exemple.fr.'), [
    'ns1.exemple.fr',
  ]);
});

test('the shape of expected values is checked per type', () => {
  assert.equal(validateDnsRecordValue('A', '203.0.113.7'), null);
  assert.ok(validateDnsRecordValue('A', '2001:db8::1'), 'an IPv6 in an A');
  assert.equal(validateDnsRecordValue('AAAA', '2001:db8::1'), null);
  assert.equal(validateDnsRecordValue('CAA', '0 issue letsencrypt.org'), null);
  assert.ok(validateDnsRecordValue('CAA', 'issue letsencrypt.org'), 'drapeaux manquants');
  assert.equal(validateDnsRecordValue('TXT', 'v=spf1 ~all'), null);
});

test('a domain carrying seventeen TXT records does not produce a two-kilobyte alert', () => {
  const actual = Array.from({ length: 17 }, (_, index) => `verification-${index}=${'x'.repeat(60)}`);
  const comparison = compareDnsRecords({
    type: 'TXT',
    expected: ['v=spf1 ~all'],
    actual,
    match: 'exact',
  });
  const message = describeDnsComparison(comparison);
  assert.equal(comparison.unexpected.length, 17);
  assert.ok(message.length < 600, `message of ${message.length} characters`);
  assert.match(message, /17 au total/);
});

// ─── dns: a query's verdict ───────────────────────────────────────────────────

test('a name that does not resolve is “unhealthy”, not “unreachable”', async () => {
  // The resolver answered: we did look, and the answer is not the expected one.
  // `unreachable` would mean "I could not look".
  const result = await getMonitorProbe('dns').run(
    { name: 'nexistepas.pupitre-test.invalid', recordType: 'A', timeoutMs: 3_000 },
    { allowlist: NOTHING_ALLOWED, language: 'fr' },
  );
  assert.equal(result.outcome, 'unhealthy');
  assert.equal(result.metrics.recordCount, 0);
});

test('an internal resolver not allowed is refused, without querying anything', async () => {
  const result = await getMonitorProbe('dns').run(
    { name: 'exemple.fr', recordType: 'A', resolver: '10.0.0.53' },
    { allowlist: NOTHING_ALLOWED, language: 'fr' },
  );
  assert.equal(result.outcome, 'unreachable');
  assert.match(result.detail ?? '', /résolveur refusé/);
  assert.match(result.detail ?? '', /MONITOR_ALLOWED_CIDRS/);
});

// ─── cadence ──────────────────────────────────────────────────────────────────

test('each type’s interval says what it costs at the other end', () => {
  // A TCP port goes down as fast as a site: the same floor as HTTP.
  assert.equal(MONITOR_TYPES.tcp.minIntervalSeconds, MONITOR_TYPES.http.minIntervalSeconds);
  // DNS does not: under the TTL one queries one's own cache, and a public resolver
  // is a shared resource we do not pay for.
  assert.equal(MONITOR_TYPES.dns.minIntervalSeconds, 300);
  assert.ok(MONITOR_TYPES.dns.minIntervalSeconds > MONITOR_TYPES.tcp.minIntervalSeconds);
});

test("the chosen intervals exist in the screen's selector", () => {
  // `apps/web` offers a fixed list of intervals; a type whose default is not in it
  // would show a value the user does not see.
  const offered = new Set([30, 60, 300, 900, 3_600, 6 * 3_600, 12 * 3_600, 86_400]);
  for (const type of ['tcp', 'dns'] as const) {
    assert.ok(offered.has(MONITOR_TYPES[type].minIntervalSeconds), `${type} : minimum absent`);
    assert.ok(offered.has(MONITOR_TYPES[type].defaultIntervalSeconds), `${type}: default missing`);
  }
});

test("both types only use field shapes the screen already renders", () => {
  // The proof that "adding a type does not touch apps/web": no new `kind`, so
  // nothing to add to the forms' rendering.
  const known = new Set(['url', 'host', 'text', 'number', 'select']);
  for (const type of ['tcp', 'dns'] as const) {
    for (const field of monitorTypeDefinition(type).fields) {
      assert.ok(known.has(field.kind), `${type}.${field.key}: new field shape`);
    }
  }
});

// ─── state machine, on realistic sequences ────────────────────────────────────

const THRESHOLDS = { failureThreshold: 3, recoveryThreshold: 2 };

function play(outcomes: MonitorOutcome[], thresholds = THRESHOLDS) {
  let state: MonitorState = {
    status: 'unknown',
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    incidentOpen: false,
  };
  const transitions: Array<'down' | 'up'> = [];
  for (const outcome of outcomes) {
    const step = nextMonitorState(state, outcome, thresholds);
    if (step.transition) transitions.push(step.transition);
    state = {
      status: step.status,
      consecutiveFailures: step.consecutiveFailures,
      consecutiveSuccesses: step.consecutiveSuccesses,
      incidentOpen: step.incidentOpen,
    };
  }
  return { state, transitions };
}

test('an isolated DNS timeout wakes nobody up', () => {
  // A query that times out now and then is a resolver's normal life, not an
  // incident.
  const { state, transitions } = play([
    'healthy',
    'healthy',
    'unreachable',
    'healthy',
    'healthy',
    'unreachable',
    'healthy',
  ]);
  assert.equal(state.status, 'healthy');
  assert.deepEqual(transitions, []);
});

test('a DNS propagation reads as one outage then one recovery', () => {
  // The A changes, the probe sees it `unhealthy` while the zone propagates, then
  // someone updates the expected value.
  const { state, transitions } = play([
    'healthy',
    'unhealthy',
    'unhealthy',
    'unhealthy',
    'unhealthy',
    'unhealthy',
    'healthy',
    'healthy',
  ]);
  assert.equal(state.status, 'healthy');
  assert.deepEqual(transitions, ['down', 'up'], 'one outage, one alert, one recovery');
});

test('a confirmed NS hijack opens a single incident', () => {
  const { state, transitions } = play(
    ['healthy', ...Array.from({ length: 20 }, () => 'unhealthy' as MonitorOutcome)],
  );
  assert.equal(state.status, 'unhealthy');
  assert.deepEqual(transitions, ['down'], 'vingt mesures, une alerte');
  assert.equal(state.consecutiveFailures, 20);
});

test('a restarting TCP service: unreachable, then silent, then healthy', () => {
  // A real container restart sequence with an expected banner: the port refuses,
  // then it accepts without being ready to announce itself, then all is well.
  const { state, transitions } = play([
    'healthy',
    'unreachable',
    'unreachable',
    'unreachable',
    'unhealthy',
    'healthy',
    'healthy',
  ]);
  assert.equal(state.status, 'healthy');
  assert.deepEqual(transitions, ['down', 'up']);
});

test("the failure's nature updates without reopening an incident", () => {
  const { state, transitions } = play([
    'healthy',
    'unreachable',
    'unreachable',
    'unreachable',
    'unhealthy',
    'unreachable',
  ]);
  assert.equal(state.status, 'unreachable');
  assert.deepEqual(transitions, ['down'], 'the port goes from closed to silent: same outage');
});
