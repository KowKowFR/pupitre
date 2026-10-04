import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MONITOR_TYPES,
  MONITOR_TYPES_LIST,
  buildMonitorAlert,
  checkAddress,
  checkUrlShape,
  classifyAddress,
  describeMonitorTarget,
  formatCadence,
  formatInterval,
  formatUptime,
  monitorTypeDefinition,
  nextMonitorState,
  parseCidrList,
  safeParseMonitorConfig,
  uptimeRatio,
  type MonitorOutcome,
  type MonitorState,
} from '../src/monitoring.js';
import { getMonitorProbe } from '../src/probe/index.js';

const THRESHOLDS = { failureThreshold: 3, recoveryThreshold: 2 };

const FRESH: MonitorState = {
  status: 'unknown',
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
  incidentOpen: false,
};

function play(outcomes: MonitorOutcome[], thresholds = THRESHOLDS, from: MonitorState = FRESH) {
  let state: MonitorState = from;
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

// ─── state machine ────────────────────────────────────────────────────────────

test('a first healthy measurement confirms “healthy” without a transition', () => {
  const { state, transitions } = play(['healthy']);
  assert.equal(state.status, 'healthy');
  assert.deepEqual(transitions, []);
});

test("an isolated failure neither brings the probe down nor opens an incident", () => {
  const { state, transitions } = play(['healthy', 'unreachable', 'healthy']);
  assert.equal(state.status, 'healthy');
  assert.deepEqual(transitions, [], 'a bounce must produce no transition');
});

test('the probe goes down at the confirmation threshold, not at the first failure', () => {
  const first = play(['healthy', 'unreachable']);
  assert.equal(first.state.status, 'healthy', 'first failure: still healthy');
  assert.deepEqual(first.transitions, []);

  const second = play(['healthy', 'unreachable', 'unreachable']);
  assert.equal(second.state.status, 'healthy', 'second failure: still healthy');
  assert.deepEqual(second.transitions, []);

  const third = play(['healthy', 'unreachable', 'unreachable', 'unreachable']);
  assert.equal(third.state.status, 'unreachable');
  assert.deepEqual(third.transitions, ['down'], 'the outage is confirmed at the third');
});

test('a single “down” transition for a lasting outage', () => {
  const { transitions } = play([
    'healthy',
    'unreachable',
    'unreachable',
    'unreachable',
    'unreachable',
    'unreachable',
    'unreachable',
  ]);
  assert.deepEqual(transitions, ['down'], 'one outage, one alert — not one per measurement');
});

test('recovery needs its threshold too', () => {
  const one = play(['healthy', 'unreachable', 'unreachable', 'unreachable', 'healthy']);
  assert.equal(one.state.status, 'unreachable', 'a single success does not bring the probe back up');
  assert.deepEqual(one.transitions, ['down']);

  const two = play(['healthy', 'unreachable', 'unreachable', 'unreachable', 'healthy', 'healthy']);
  assert.equal(two.state.status, 'healthy');
  assert.deepEqual(two.transitions, ['down', 'up']);
});

test('a threshold of 1 brings the probe down at the first failure', () => {
  const { state, transitions } = play(['healthy', 'unhealthy'], {
    failureThreshold: 1,
    recoveryThreshold: 1,
  });
  assert.equal(state.status, 'unhealthy');
  assert.deepEqual(transitions, ['down']);
});

test("the outage's nature updates without reopening an incident", () => {
  const { state, transitions } = play([
    'healthy',
    'unreachable',
    'unreachable',
    'unreachable',
    'unhealthy',
  ]);
  assert.equal(state.status, 'unhealthy');
  assert.deepEqual(transitions, ['down']);
});

test('from unknown, failures need the full threshold', () => {
  const { state, transitions } = play(['unreachable', 'unreachable']);
  assert.equal(state.status, 'unknown');
  assert.deepEqual(transitions, []);
});

test("the incident follows the outage: opened at the fall, closed at the recovery", () => {
  const down = play(['healthy', 'unreachable', 'unreachable', 'unreachable']);
  assert.equal(down.state.incidentOpen, true);
  const up = play(['healthy', 'unreachable', 'unreachable', 'unreachable', 'healthy', 'healthy']);
  assert.equal(up.state.incidentOpen, false);
});

// ─── target change during an outage ───────────────────────────────────────────

/** What `updateMonitor` leaves when the URL of a down probe is changed. */
const RETARGETED: MonitorState = {
  status: 'unknown',
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
  incidentOpen: true,
};

test('new healthy target: the recovery waits for its threshold, then announces itself', () => {
  const one = play(['healthy'], THRESHOLDS, RETARGETED);
  assert.equal(one.state.status, 'unknown', 'one success does not close an announced incident');
  assert.deepEqual(one.transitions, []);

  const two = play(['healthy', 'healthy'], THRESHOLDS, RETARGETED);
  assert.equal(two.state.status, 'healthy');
  assert.equal(two.state.incidentOpen, false);
  assert.deepEqual(two.transitions, ['up'], 'the return to normal is announced');
});

test('new failing target: the same outage goes on, without a second alert', () => {
  const { state, transitions } = play(['unreachable', 'unhealthy'], THRESHOLDS, RETARGETED);
  assert.equal(state.status, 'unhealthy', "the state says the outage from the first failure");
  assert.equal(state.incidentOpen, true);
  assert.deepEqual(transitions, []);
});

test('after the recovery, the next outage is announced again', () => {
  const { transitions } = play(
    ['healthy', 'healthy', 'unreachable', 'unreachable', 'unreachable'],
    THRESHOLDS,
    RETARGETED,
  );
  assert.deepEqual(transitions, ['up', 'down']);
});

test('an incident left open under a “healthy” state closes at the next success', () => {
  // The state the old code left: target changed during an outage, then a healthy
  // measurement — "healthy" shown, incident still open.
  const stuck: MonitorState = {
    status: 'healthy',
    consecutiveFailures: 0,
    consecutiveSuccesses: 12,
    incidentOpen: true,
  };
  const { state, transitions } = play(['healthy'], THRESHOLDS, stuck);
  assert.equal(state.incidentOpen, false);
  assert.deepEqual(transitions, ['up']);
});

// ─── availability rate ────────────────────────────────────────────────────────

test('a rate without measurements is null, never 0%', () => {
  assert.equal(uptimeRatio(0, 0), null);
  assert.equal(formatUptime({ hours: 24, samples: 0, up: 0, ratio: null }), 'aucune mesure');
});

test('the rate says how many measurements it covers', () => {
  assert.equal(formatUptime({ hours: 24, samples: 3, up: 3, ratio: 1 }), '100 % sur 3 mesures');
  assert.equal(
    formatUptime({ hours: 24, samples: 1440, up: 1439, ratio: 1439 / 1440 }),
    '99,93 % sur 1440 mesures',
  );
  assert.equal(formatUptime({ hours: 24, samples: 1, up: 1, ratio: 1 }), '100 % sur 1 mesure');
});

test('the rate is exact on a known history', () => {
  assert.equal(uptimeRatio(9, 10), 0.9);
  assert.equal(
    formatUptime({ hours: 24, samples: 10, up: 9, ratio: 0.9 }),
    '90,00 % sur 10 mesures',
  );
});

test('durations and intervals read in French', () => {
  assert.equal(formatInterval(30), '30 secondes');
  assert.equal(formatInterval(60), '1 minute');
  assert.equal(formatInterval(300), '5 minutes');
  assert.equal(formatInterval(3600), '1 heure');
  assert.equal(formatInterval(21600), '6 heures');
  assert.equal(formatInterval(86400), '1 jour');

  // French does not compose: « toutes les » before a minute, « tous les » before
  // a day. Concatenating a duration after a frozen « toutes les » produced
  // « toutes les heure ».
  assert.equal(formatCadence(30), 'toutes les 30 secondes');
  assert.equal(formatCadence(60), 'toutes les minutes');
  assert.equal(formatCadence(300), 'toutes les 5 minutes');
  assert.equal(formatCadence(3600), 'toutes les heures');
  assert.equal(formatCadence(21600), 'toutes les 6 heures');
  assert.equal(formatCadence(86400), 'tous les jours');
  assert.equal(formatCadence(2 * 86400), 'tous les 2 jours');
});

// ─── catalog: the abstraction ─────────────────────────────────────────────────

test('each type declares everything the screen needs', () => {
  for (const type of MONITOR_TYPES_LIST) {
    const definition = monitorTypeDefinition(type);
    assert.equal(definition.type, type);
    assert.ok(definition.label.length > 0, `${type}: label missing`);
    assert.ok(definition.description.length > 0, `${type} : description manquante`);
    assert.ok(definition.neverDoes.length > 0, `${type}: “never does” missing`);
    assert.ok(definition.fields.length > 0, `${type} : aucun champ de configuration`);
    assert.ok(definition.metrics.length > 0, `${type}: no measurement declared`);
    assert.ok(definition.minIntervalSeconds >= 30, `${type} : cadence minimale absurde`);
    assert.ok(
      definition.defaultIntervalSeconds >= definition.minIntervalSeconds,
      `${type}: the default interval is under the minimum`,
    );
    // The starting values must at least have the right shape — empty required
    // fields are expected, the screen has them filled in.
    assert.ok(definition.defaults !== undefined, `${type}: no starting values`);
  }
});

test('each catalog type has a registered probe', () => {
  for (const type of MONITOR_TYPES_LIST) {
    const probe = getMonitorProbe(type);
    assert.ok(probe, `${type}: no probe`);
    assert.equal(probe.type, type, `${type}: the probe announces another type`);
  }
});

test('the declared fields exist in the type’s schema', () => {
  for (const type of MONITOR_TYPES_LIST) {
    const definition = monitorTypeDefinition(type);
    const defaults = definition.defaults as Record<string, unknown>;
    for (const field of definition.fields) {
      assert.ok(field.key in defaults, `${type}.${field.key}: missing from the starting values`);
    }
  }
});

test('TLS’s minimum interval is much slower than HTTP’s', () => {
  // A certificate does not change by the minute, and each measurement is a full
  // handshake at someone else's.
  assert.ok(MONITOR_TYPES.tls.minIntervalSeconds > MONITOR_TYPES.http.minIntervalSeconds);
  assert.equal(MONITOR_TYPES.http.minIntervalSeconds, 30);
  assert.equal(MONITOR_TYPES.tls.minIntervalSeconds, 3600);
});

test('the configuration is validated by its type’s schema', () => {
  const good = safeParseMonitorConfig('http', { url: 'https://exemple.fr/' });
  assert.equal(good.ok, true);

  const bad = safeParseMonitorConfig('http', { url: 'file:///etc/passwd' });
  assert.equal(bad.ok, false);

  // An HTTP configuration is not a TLS configuration: the catalog knows it,
  // nobody else needs to.
  const mixed = safeParseMonitorConfig('tls', { url: 'https://exemple.fr/' });
  assert.equal(mixed.ok, false);
});

test('the target describes itself without knowing the type', () => {
  assert.equal(describeMonitorTarget('http', { url: 'https://exemple.fr/' }), 'https://exemple.fr/');
  assert.equal(describeMonitorTarget('tls', { host: 'exemple.fr' }), 'exemple.fr');
  assert.equal(describeMonitorTarget('tls', { host: 'exemple.fr', port: 8443 }), 'exemple.fr:8443');
  assert.equal(describeMonitorTarget('http', { url: 'not a url' }), '(unreadable configuration)');
  assert.equal(
    describeMonitorTarget('http', { url: 'not a url' }, 'fr'),
    '(configuration illisible)',
  );
});

test('the keyword exists at both levels, and both levels stay distinct', () => {
  // The shortcut: an option of the HTTP probe, exact substring, for whoever just
  // wants to check a stable token without creating a second type.
  const shortcut = safeParseMonitorConfig('http', {
    url: 'https://exemple.fr/',
    keyword: 'Bienvenue',
  });
  assert.equal(shortcut.ok, true);

  // The type: presence *and* absence, tolerant comparison, adjustable read cap.
  // What the HTTP probe's field will never be able to do without becoming a
  // catalog hidden in an option.
  const full = safeParseMonitorConfig('keyword', {
    url: 'https://exemple.fr/',
    mustContain: 'Se connecter',
    mustNotContain: 'Erreur 500',
  });
  assert.equal(full.ok, true);

  // The HTTP option must not disappear: probes carry it in the database, and Zod
  // strips unknown keys without saying anything — removing it would *silently*
  // turn those probes green again.
  assert.ok('keyword' in (MONITOR_TYPES.http.defaults as Record<string, unknown>));
});

// ─── SSRF policy ──────────────────────────────────────────────────────────────

test('exotic schemes are refused', () => {
  assert.equal(checkUrlShape('https://example.com/').allowed, true);
  assert.equal(checkUrlShape('http://example.com/').allowed, true);
  assert.equal(checkUrlShape('file:///etc/passwd').allowed, false);
  assert.equal(checkUrlShape('gopher://example.com/').allowed, false);
  assert.equal(checkUrlShape('ftp://example.com/').allowed, false);
  assert.equal(checkUrlShape('not a url').allowed, false);
});

test('a URL carrying credentials is refused', () => {
  assert.equal(checkUrlShape('https://admin:secret@example.com/').allowed, false);
});

test('localhost is refused by its name, not only by its address', () => {
  assert.equal(checkUrlShape('http://localhost:3000/').allowed, false);
  assert.equal(checkUrlShape('http://app.localhost/').allowed, false);
});

test('address classification', () => {
  assert.equal(classifyAddress('93.184.216.34'), 'public');
  assert.equal(classifyAddress('127.0.0.1'), 'loopback');
  assert.equal(classifyAddress('10.1.2.3'), 'private');
  assert.equal(classifyAddress('172.16.0.1'), 'private');
  assert.equal(classifyAddress('172.32.0.1'), 'public', '172.32 is outside the /12');
  assert.equal(classifyAddress('192.168.1.1'), 'private');
  assert.equal(classifyAddress('169.254.169.254'), 'link-local');
  assert.equal(classifyAddress('100.64.0.1'), 'cgnat');
  assert.equal(classifyAddress('0.0.0.0'), 'unspecified');
  assert.equal(classifyAddress('::1'), 'loopback');
  assert.equal(classifyAddress('fe80::1'), 'link-local');
  assert.equal(classifyAddress('fd00::1'), 'unique-local');
  assert.equal(classifyAddress('2606:4700:4700::1111'), 'public');
});

test('wrapped forms do not bypass the check', () => {
  assert.equal(classifyAddress('::ffff:127.0.0.1'), 'loopback');
  assert.equal(classifyAddress('::ffff:169.254.169.254'), 'link-local');
  assert.equal(classifyAddress('::ffff:10.0.0.1'), 'private');
});

test('decorative octets are not addresses', () => {
  // `0177.0.0.1` is 127.0.0.1 in octal: we refuse to read it rather than read it
  // wrong.
  assert.equal(classifyAddress('0177.0.0.1'), null);
  assert.equal(classifyAddress('010.0.0.1'), null);
  assert.equal(classifyAddress('2130706433'), null);
});

test("without an allow list, everything that is not public is refused", () => {
  const none = parseCidrList(undefined);
  assert.equal(checkAddress('93.184.216.34', none).allowed, true);
  assert.equal(checkAddress('127.0.0.1', none).allowed, false);
  assert.equal(checkAddress('10.0.0.5', none).allowed, false);
  assert.equal(checkAddress('192.168.1.20', none).allowed, false);
  assert.equal(checkAddress('169.254.169.254', none).allowed, false);
});

test("the allow list opens exactly the requested range", () => {
  const allow = parseCidrList('10.0.0.0/8, 192.168.1.0/24');
  assert.equal(checkAddress('10.9.9.9', allow).allowed, true);
  assert.equal(checkAddress('192.168.1.20', allow).allowed, true);
  assert.equal(checkAddress('192.168.2.20', allow).allowed, false, 'hors du /24');
  assert.equal(checkAddress('172.16.0.1', allow).allowed, false, 'range not listed');
  assert.equal(checkAddress('127.0.0.1', allow).allowed, false, 'loopback not listed');
});

test('link-local stays refused even when listed explicitly', () => {
  const allow = parseCidrList('169.254.0.0/16,0.0.0.0/0');
  const verdict = checkAddress('169.254.169.254', allow);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.allowed ? '' : verdict.reason, /aucune liste/);
});

test('an unreadable CIDR is ignored, not fatal', () => {
  assert.equal(parseCidrList('not-a-cidr, 10.0.0.0/8').length, 1);
  assert.equal(parseCidrList('10.0.0.0/99').length, 0);
});

test('the SSRF policy holds for every type, not only HTTP', () => {
  // The TLS probe takes not a URL but a host: the check must still apply,
  // otherwise the next type reopens the hole.
  assert.equal(safeParseMonitorConfig('tls', { host: 'localhost' }).ok, false);
  assert.equal(safeParseMonitorConfig('tls', { host: 'https://exemple.fr' }).ok, false);
  assert.equal(safeParseMonitorConfig('tls', { host: 'exemple.fr' }).ok, true);
});

// ─── alert payload ────────────────────────────────────────────────────────────

test('the alert carries text and content, for Slack as for Discord', () => {
  const alert = buildMonitorAlert({
    event: 'monitor.down',
    monitor: { id: 'm1', name: 'Site', type: 'http', target: 'https://example.com/' },
    incident: { id: 'i1', startedAt: new Date('2026-01-01T00:00:00Z'), resolvedAt: null },
    status: 'unreachable',
    detail: 'ECONNREFUSED',
    metrics: { httpStatus: null },
    consecutiveFailures: 3,
  });
  assert.equal(alert.event, 'monitor.down');
  assert.equal(alert.text, alert.content);
  assert.match(alert.text, /ECONNREFUSED/);
  assert.equal(alert.incident.durationSeconds, null);
});

test("the recovery alert carries the outage's duration", () => {
  const alert = buildMonitorAlert({
    event: 'monitor.up',
    monitor: { id: 'm1', name: 'Site', type: 'tls', target: 'example.com' },
    incident: {
      id: 'i1',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      resolvedAt: new Date('2026-01-01T00:05:00Z'),
    },
    status: 'healthy',
    detail: null,
    metrics: { daysRemaining: 62 },
    consecutiveFailures: 0,
  });
  assert.equal(alert.incident.durationSeconds, 300);
  assert.match(alert.text, /5 min/);
  assert.equal(alert.monitor.type, 'tls');
});
