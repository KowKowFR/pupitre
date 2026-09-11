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

function play(outcomes: MonitorOutcome[], thresholds = THRESHOLDS) {
  let state: MonitorState = { status: 'unknown', consecutiveFailures: 0, consecutiveSuccesses: 0 };
  const transitions: Array<'down' | 'up'> = [];
  for (const outcome of outcomes) {
    const step = nextMonitorState(state, outcome, thresholds);
    if (step.transition) transitions.push(step.transition);
    state = {
      status: step.status,
      consecutiveFailures: step.consecutiveFailures,
      consecutiveSuccesses: step.consecutiveSuccesses,
    };
  }
  return { state, transitions };
}

// ─── machine à états ──────────────────────────────────────────────────────────

test('une première mesure saine confirme « sain » sans transition', () => {
  const { state, transitions } = play(['healthy']);
  assert.equal(state.status, 'healthy');
  assert.deepEqual(transitions, []);
});

test("un échec isolé ne fait pas tomber la sonde ni ouvrir d'incident", () => {
  const { state, transitions } = play(['healthy', 'unreachable', 'healthy']);
  assert.equal(state.status, 'healthy');
  assert.deepEqual(transitions, [], 'un rebond ne doit produire aucune transition');
});

test('la sonde tombe au seuil de confirmation, pas au premier échec', () => {
  const first = play(['healthy', 'unreachable']);
  assert.equal(first.state.status, 'healthy', 'premier échec : toujours saine');
  assert.deepEqual(first.transitions, []);

  const second = play(['healthy', 'unreachable', 'unreachable']);
  assert.equal(second.state.status, 'healthy', 'deuxième échec : toujours saine');
  assert.deepEqual(second.transitions, []);

  const third = play(['healthy', 'unreachable', 'unreachable', 'unreachable']);
  assert.equal(third.state.status, 'unreachable');
  assert.deepEqual(third.transitions, ['down'], 'la panne est confirmée au troisième');
});

test('une seule transition « down » pour une panne qui dure', () => {
  const { transitions } = play([
    'healthy',
    'unreachable',
    'unreachable',
    'unreachable',
    'unreachable',
    'unreachable',
    'unreachable',
  ]);
  assert.deepEqual(transitions, ['down'], 'une panne, une alerte — pas une par mesure');
});

test('le rétablissement demande lui aussi son seuil', () => {
  const one = play(['healthy', 'unreachable', 'unreachable', 'unreachable', 'healthy']);
  assert.equal(one.state.status, 'unreachable', 'un seul succès ne relève pas la sonde');
  assert.deepEqual(one.transitions, ['down']);

  const two = play(['healthy', 'unreachable', 'unreachable', 'unreachable', 'healthy', 'healthy']);
  assert.equal(two.state.status, 'healthy');
  assert.deepEqual(two.transitions, ['down', 'up']);
});

test('un seuil à 1 fait tomber la sonde dès le premier échec', () => {
  const { state, transitions } = play(['healthy', 'unhealthy'], {
    failureThreshold: 1,
    recoveryThreshold: 1,
  });
  assert.equal(state.status, 'unhealthy');
  assert.deepEqual(transitions, ['down']);
});

test("la nature de la panne se met à jour sans rouvrir d'incident", () => {
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

test('depuis unknown, les échecs demandent le seuil complet', () => {
  const { state, transitions } = play(['unreachable', 'unreachable']);
  assert.equal(state.status, 'unknown');
  assert.deepEqual(transitions, []);
});

// ─── taux de disponibilité ────────────────────────────────────────────────────

test('un taux sans mesure vaut null, jamais 0 %', () => {
  assert.equal(uptimeRatio(0, 0), null);
  assert.equal(formatUptime({ hours: 24, samples: 0, up: 0, ratio: null }), 'aucune mesure');
});

test('le taux dit sur combien de mesures il porte', () => {
  assert.equal(formatUptime({ hours: 24, samples: 3, up: 3, ratio: 1 }), '100 % sur 3 mesures');
  assert.equal(
    formatUptime({ hours: 24, samples: 1440, up: 1439, ratio: 1439 / 1440 }),
    '99,93 % sur 1440 mesures',
  );
  assert.equal(formatUptime({ hours: 24, samples: 1, up: 1, ratio: 1 }), '100 % sur 1 mesure');
});

test('le taux est exact sur un historique connu', () => {
  assert.equal(uptimeRatio(9, 10), 0.9);
  assert.equal(
    formatUptime({ hours: 24, samples: 10, up: 9, ratio: 0.9 }),
    '90,00 % sur 10 mesures',
  );
});

test('les durées et les cadences se lisent en français', () => {
  assert.equal(formatInterval(30), '30 secondes');
  assert.equal(formatInterval(60), '1 minute');
  assert.equal(formatInterval(300), '5 minutes');
  assert.equal(formatInterval(3600), '1 heure');
  assert.equal(formatInterval(21600), '6 heures');
  assert.equal(formatInterval(86400), '1 jour');

  // Le français ne se compose pas : « toutes les » devant une minute, « tous
  // les » devant un jour. Concaténer une durée après un « toutes les » figé
  // produisait « toutes les heure ».
  assert.equal(formatCadence(30), 'toutes les 30 secondes');
  assert.equal(formatCadence(60), 'toutes les minutes');
  assert.equal(formatCadence(300), 'toutes les 5 minutes');
  assert.equal(formatCadence(3600), 'toutes les heures');
  assert.equal(formatCadence(21600), 'toutes les 6 heures');
  assert.equal(formatCadence(86400), 'tous les jours');
  assert.equal(formatCadence(2 * 86400), 'tous les 2 jours');
});

// ─── catalogue : l'abstraction ────────────────────────────────────────────────

test('chaque type déclare tout ce dont l\'écran a besoin', () => {
  for (const type of MONITOR_TYPES_LIST) {
    const definition = monitorTypeDefinition(type);
    assert.equal(definition.type, type);
    assert.ok(definition.label.length > 0, `${type} : libellé manquant`);
    assert.ok(definition.description.length > 0, `${type} : description manquante`);
    assert.ok(definition.neverDoes.length > 0, `${type} : « ne fait pas » manquant`);
    assert.ok(definition.fields.length > 0, `${type} : aucun champ de configuration`);
    assert.ok(definition.metrics.length > 0, `${type} : aucune mesure déclarée`);
    assert.ok(definition.minIntervalSeconds >= 30, `${type} : cadence minimale absurde`);
    assert.ok(
      definition.defaultIntervalSeconds >= definition.minIntervalSeconds,
      `${type} : la cadence par défaut est sous le minimum`,
    );
    // Les valeurs de départ doivent au moins être de la bonne forme — les
    // champs obligatoires vides sont attendus, l'écran les fait remplir.
    assert.ok(definition.defaults !== undefined, `${type} : pas de valeurs de départ`);
  }
});

test('chaque type du catalogue a une sonde enregistrée', () => {
  for (const type of MONITOR_TYPES_LIST) {
    const probe = getMonitorProbe(type);
    assert.ok(probe, `${type} : aucune sonde`);
    assert.equal(probe.type, type, `${type} : la sonde annonce un autre type`);
  }
});

test('les champs déclarés existent dans le schéma du type', () => {
  for (const type of MONITOR_TYPES_LIST) {
    const definition = monitorTypeDefinition(type);
    const defaults = definition.defaults as Record<string, unknown>;
    for (const field of definition.fields) {
      assert.ok(field.key in defaults, `${type}.${field.key} : absent des valeurs de départ`);
    }
  }
});

test('la cadence minimale de TLS est bien plus lente que celle de HTTP', () => {
  // Un certificat ne change pas à la minute, et chaque mesure est une poignée
  // de main complète chez quelqu'un d'autre.
  assert.ok(MONITOR_TYPES.tls.minIntervalSeconds > MONITOR_TYPES.http.minIntervalSeconds);
  assert.equal(MONITOR_TYPES.http.minIntervalSeconds, 30);
  assert.equal(MONITOR_TYPES.tls.minIntervalSeconds, 3600);
});

test('la configuration est validée par le schéma de son type', () => {
  const good = safeParseMonitorConfig('http', { url: 'https://exemple.fr/' });
  assert.equal(good.ok, true);

  const bad = safeParseMonitorConfig('http', { url: 'file:///etc/passwd' });
  assert.equal(bad.ok, false);

  // Une configuration HTTP n'est pas une configuration TLS : le catalogue le
  // sait, personne d'autre n'a besoin de le savoir.
  const mixed = safeParseMonitorConfig('tls', { url: 'https://exemple.fr/' });
  assert.equal(mixed.ok, false);
});

test('la cible se décrit sans connaître le type', () => {
  assert.equal(describeMonitorTarget('http', { url: 'https://exemple.fr/' }), 'https://exemple.fr/');
  assert.equal(describeMonitorTarget('tls', { host: 'exemple.fr' }), 'exemple.fr');
  assert.equal(describeMonitorTarget('tls', { host: 'exemple.fr', port: 8443 }), 'exemple.fr:8443');
  assert.equal(describeMonitorTarget('http', { url: 'pas une url' }), '(configuration illisible)');
});

test('le mot-clé est une option de la sonde HTTP, pas un type à part', () => {
  const withKeyword = safeParseMonitorConfig('http', {
    url: 'https://exemple.fr/',
    keyword: 'Bienvenue',
  });
  assert.equal(withKeyword.ok, true);
  assert.equal(
    MONITOR_TYPES_LIST.filter((type) => type.includes('keyword')).length,
    0,
    'aucun type « keyword » ne doit exister',
  );
});

// ─── politique SSRF ───────────────────────────────────────────────────────────

test('les schémas exotiques sont refusés', () => {
  assert.equal(checkUrlShape('https://example.com/').allowed, true);
  assert.equal(checkUrlShape('http://example.com/').allowed, true);
  assert.equal(checkUrlShape('file:///etc/passwd').allowed, false);
  assert.equal(checkUrlShape('gopher://example.com/').allowed, false);
  assert.equal(checkUrlShape('ftp://example.com/').allowed, false);
  assert.equal(checkUrlShape('pas une url').allowed, false);
});

test('une URL portant des identifiants est refusée', () => {
  assert.equal(checkUrlShape('https://admin:secret@example.com/').allowed, false);
});

test('localhost est refusé par son nom, pas seulement par son adresse', () => {
  assert.equal(checkUrlShape('http://localhost:3000/').allowed, false);
  assert.equal(checkUrlShape('http://app.localhost/').allowed, false);
});

test('classification des adresses', () => {
  assert.equal(classifyAddress('93.184.216.34'), 'public');
  assert.equal(classifyAddress('127.0.0.1'), 'loopback');
  assert.equal(classifyAddress('10.1.2.3'), 'private');
  assert.equal(classifyAddress('172.16.0.1'), 'private');
  assert.equal(classifyAddress('172.32.0.1'), 'public', '172.32 est hors du /12');
  assert.equal(classifyAddress('192.168.1.1'), 'private');
  assert.equal(classifyAddress('169.254.169.254'), 'link-local');
  assert.equal(classifyAddress('100.64.0.1'), 'cgnat');
  assert.equal(classifyAddress('0.0.0.0'), 'unspecified');
  assert.equal(classifyAddress('::1'), 'loopback');
  assert.equal(classifyAddress('fe80::1'), 'link-local');
  assert.equal(classifyAddress('fd00::1'), 'unique-local');
  assert.equal(classifyAddress('2606:4700:4700::1111'), 'public');
});

test('les formes encapsulées ne contournent pas le contrôle', () => {
  assert.equal(classifyAddress('::ffff:127.0.0.1'), 'loopback');
  assert.equal(classifyAddress('::ffff:169.254.169.254'), 'link-local');
  assert.equal(classifyAddress('::ffff:10.0.0.1'), 'private');
});

test('les octets décoratifs ne sont pas des adresses', () => {
  // `0177.0.0.1` est 127.0.0.1 en octal : on refuse de le lire plutôt que de le
  // lire de travers.
  assert.equal(classifyAddress('0177.0.0.1'), null);
  assert.equal(classifyAddress('010.0.0.1'), null);
  assert.equal(classifyAddress('2130706433'), null);
});

test("sans liste d'autorisation, tout ce qui n'est pas public est refusé", () => {
  const none = parseCidrList(undefined);
  assert.equal(checkAddress('93.184.216.34', none).allowed, true);
  assert.equal(checkAddress('127.0.0.1', none).allowed, false);
  assert.equal(checkAddress('10.0.0.5', none).allowed, false);
  assert.equal(checkAddress('192.168.1.20', none).allowed, false);
  assert.equal(checkAddress('169.254.169.254', none).allowed, false);
});

test("la liste d'autorisation ouvre exactement la plage demandée", () => {
  const allow = parseCidrList('10.0.0.0/8, 192.168.1.0/24');
  assert.equal(checkAddress('10.9.9.9', allow).allowed, true);
  assert.equal(checkAddress('192.168.1.20', allow).allowed, true);
  assert.equal(checkAddress('192.168.2.20', allow).allowed, false, 'hors du /24');
  assert.equal(checkAddress('172.16.0.1', allow).allowed, false, 'plage non listée');
  assert.equal(checkAddress('127.0.0.1', allow).allowed, false, 'bouclage non listé');
});

test('le lien-local reste refusé même listé explicitement', () => {
  const allow = parseCidrList('169.254.0.0/16,0.0.0.0/0');
  const verdict = checkAddress('169.254.169.254', allow);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.allowed ? '' : verdict.reason, /aucune liste/);
});

test('un CIDR illisible est ignoré, pas fatal', () => {
  assert.equal(parseCidrList('pas-un-cidr, 10.0.0.0/8').length, 1);
  assert.equal(parseCidrList('10.0.0.0/99').length, 0);
});

test('la politique SSRF vaut pour tous les types, pas seulement HTTP', () => {
  // La sonde TLS ne prend pas d'URL mais un hôte : le contrôle doit quand même
  // s'appliquer, sinon le type suivant rouvre le trou.
  assert.equal(safeParseMonitorConfig('tls', { host: 'localhost' }).ok, false);
  assert.equal(safeParseMonitorConfig('tls', { host: 'https://exemple.fr' }).ok, false);
  assert.equal(safeParseMonitorConfig('tls', { host: 'exemple.fr' }).ok, true);
});

// ─── charge utile d'alerte ────────────────────────────────────────────────────

test('l\'alerte porte text et content, pour Slack comme pour Discord', () => {
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

test("l'alerte de rétablissement porte la durée de la panne", () => {
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
