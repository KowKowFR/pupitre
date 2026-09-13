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

// ─── tcp : le schéma ──────────────────────────────────────────────────────────

test('une sonde TCP se configure avec un hôte et un port', () => {
  const parsed = safeParseMonitorConfig('tcp', { host: 'exemple.fr', port: 25 });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.config : null, {
    host: 'exemple.fr',
    port: 25,
    expectBanner: null,
    timeoutMs: 10_000,
  });
});

test('un port hors bornes est refusé', () => {
  assert.equal(safeParseMonitorConfig('tcp', { host: 'exemple.fr', port: 0 }).ok, false);
  assert.equal(safeParseMonitorConfig('tcp', { host: 'exemple.fr', port: 70_000 }).ok, false);
  assert.equal(safeParseMonitorConfig('tcp', { host: 'exemple.fr', port: 25.5 }).ok, false);
});

test("une configuration TCP n'est pas une configuration HTTP", () => {
  assert.equal(safeParseMonitorConfig('tcp', { url: 'https://exemple.fr/' }).ok, false);
  assert.equal(safeParseMonitorConfig('tcp', { host: 'exemple.fr:25' }).ok, false);
});

// ─── tcp : la garde SSRF, à la création ───────────────────────────────────────

test('une sonde TCP vers un service de métadonnées est refusée par le schéma', () => {
  // Le lien-local n'est débloqué par aucune liste : le refus peut donc tomber
  // dans le schéma, sans lire l'environnement et sans résoudre quoi que ce soit.
  const parsed = safeParseMonitorConfig('tcp', { host: '169.254.169.254', port: 80 });
  assert.equal(parsed.ok, false);
  assert.match(
    parsed.ok ? '' : parsed.error.issues.map((issue) => issue.message).join(' '),
    /aucune liste/,
  );
});

test('le refus du lien-local vaut pour tous les types, pas seulement TCP', () => {
  assert.equal(safeParseMonitorConfig('tls', { host: '169.254.169.254' }).ok, false);
  assert.equal(safeParseMonitorConfig('http', { url: 'http://169.254.169.254/latest/' }).ok, false);
  assert.equal(checkHostname('169.254.169.254').allowed, false);
  assert.equal(checkHostname('::ffff:169.254.169.254').allowed, false, 'forme encapsulée');
  assert.equal(checkHostname('exemple.fr').allowed, true);
});

test('une sonde TCP vers le bouclage ou une plage privée est refusée à la création', () => {
  for (const host of ['127.0.0.1', '10.0.0.5', '192.168.1.20', '172.16.3.4', '100.64.0.1']) {
    const verdict = checkMonitorTargetLiterals('tcp', { host, port: 5432 }, NOTHING_ALLOWED);
    assert.equal(verdict.allowed, false, `${host} aurait dû être refusé`);
    assert.equal(verdict.allowed ? '' : verdict.field, 'host');
  }
});

test("une cible IPv6 littérale ne se saisit pas du tout dans un champ « hôte »", () => {
  // `monitorHostSchema` refuse tout ce qui contient « : », forme entre crochets
  // comprise. Limitation antérieure à ce chantier, et conservatrice : aucune
  // cible IPv6 littérale ne peut être créée, donc aucune ne contourne la garde.
  // Un résolveur DNS, lui, n'est pas un nom d'hôte et accepte l'IPv6 — il est
  // contrôlé comme les autres.
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

test("la même cible passe si l'exploitant a ouvert la plage", () => {
  const verdict = checkMonitorTargetLiterals(
    'tcp',
    { host: '127.0.0.1', port: 5432 },
    LOOPBACK_ALLOWED,
  );
  assert.equal(verdict.allowed, true, 'MONITOR_ALLOWED_CIDRS est là pour ça');
});

test('le contrôle de création se déduit des champs déclarés, sans switch sur le type', () => {
  // Aucun `if (type === …)` : ce sont les `kind: 'host' | 'url'` du catalogue
  // qui disent quels champs sont des cibles de connexion. Les types existants
  // en profitent donc aussi.
  assert.equal(
    checkMonitorTargetLiterals('tls', { host: '10.0.0.5' }, NOTHING_ALLOWED).allowed,
    false,
  );
  assert.equal(
    checkMonitorTargetLiterals('http', { url: 'http://10.0.0.5:8080/' }, NOTHING_ALLOWED).allowed,
    false,
  );
  // Un nom ne se juge pas ici : il n'est contrôlé qu'une fois résolu.
  assert.equal(
    checkMonitorTargetLiterals('tcp', { host: 'exemple.fr', port: 25 }, NOTHING_ALLOWED).allowed,
    true,
  );
});

test("le nom interrogé d'une sonde DNS n'est pas une cible de connexion", () => {
  // On ne s'y connecte jamais : le contrôler reviendrait à interdire de
  // superviser « le A de db.interne vaut bien 10.0.0.5 », qui ne joint rien.
  const verdict = checkMonitorTargetLiterals(
    'dns',
    { name: 'db.interne', recordType: 'A', expected: '10.0.0.5' },
    NOTHING_ALLOWED,
  );
  assert.equal(verdict.allowed, true);
});

test('le résolveur déclaré, lui, est bien une cible de connexion', () => {
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

// ─── tcp : la garde SSRF, à l'exécution ───────────────────────────────────────

test("une sonde TCP vers le bouclage est refusée à l'exécution, liste vide", async () => {
  const result = await getMonitorProbe('tcp').run(
    { host: '127.0.0.1', port: 5432 },
    { allowlist: NOTHING_ALLOWED },
  );
  assert.equal(result.outcome, 'unreachable');
  assert.match(result.detail ?? '', /bouclage/);
  assert.match(result.detail ?? '', /MONITOR_ALLOWED_CIDRS/);
});

test("une sonde TCP vers une plage privée est refusée à l'exécution", async () => {
  const result = await getMonitorProbe('tcp').run(
    { host: '10.0.0.5', port: 22 },
    { allowlist: NOTHING_ALLOWED },
  );
  assert.equal(result.outcome, 'unreachable');
  assert.match(result.detail ?? '', /privée/);
});

test("une sonde TCP vers le service de métadonnées est refusée à l'exécution aussi", async () => {
  // Le schéma la refuse déjà, mais une sonde peut avoir été créée avant que la
  // garde n'existe : la seconde ligne de défense doit tenir seule.
  const viaProbe = await getMonitorProbe('tcp').run(
    { host: '169.254.169.254', port: 80 },
    { allowlist: parseCidrList('0.0.0.0/0') },
  );
  assert.equal(viaProbe.outcome, 'unreachable');

  await assert.rejects(
    () => resolveGuarded('169.254.169.254', parseCidrList('0.0.0.0/0')),
    /aucune liste/,
    'même une liste tout-ouvert ne débloque pas le lien-local',
  );
});

test('la garde ne se contourne pas par un nom qui pointe sur le bouclage', async () => {
  // `localhost` est refusé par son nom ; toute autre entrée pointant sur
  // 127.0.0.1 tombe au contrôle des adresses résolues.
  const result = await getMonitorProbe('tcp').run(
    { host: 'localhost', port: 5432 },
    { allowlist: parseCidrList('127.0.0.0/8') },
  );
  assert.equal(result.outcome, 'unreachable');
  assert.match(result.detail ?? '', /localhost/);
});

// ─── tcp : la mesure, contre une vraie socket ─────────────────────────────────

function listen(handler: (socket: import('node:net').Socket) => void): Promise<Server> {
  const server = createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('port introuvable');
  return address.port;
}

test('un port qui écoute est sain, un port fermé est injoignable', async () => {
  const server = await listen(() => {});
  const port = portOf(server);
  try {
    const up = await getMonitorProbe('tcp').run(
      { host: '127.0.0.1', port },
      { allowlist: LOOPBACK_ALLOWED },
    );
    assert.equal(up.outcome, 'healthy');
    assert.equal(typeof up.metrics.connectMs, 'number');
    assert.equal(up.metrics.address, '127.0.0.1');
  } finally {
    server.close();
  }

  const down = await getMonitorProbe('tcp').run(
    { host: '127.0.0.1', port },
    { allowlist: LOOPBACK_ALLOWED },
  );
  assert.equal(down.outcome, 'unreachable', 'le port vient de fermer');
  assert.match(down.detail ?? '', /ECONNREFUSED/);
});

test('la bannière distingue « ça écoute » de « le bon service écoute »', async () => {
  const server = await listen((socket) => socket.write('220 mail.exemple.fr ESMTP Postfix\r\n'));
  const port = portOf(server);
  try {
    const good = await getMonitorProbe('tcp').run(
      { host: '127.0.0.1', port, expectBanner: '220 ' },
      { allowlist: LOOPBACK_ALLOWED },
    );
    assert.equal(good.outcome, 'healthy');
    assert.equal(good.metrics.banner, '220 mail.exemple.fr ESMTP Postfix');

    const insensitive = await getMonitorProbe('tcp').run(
      { host: '127.0.0.1', port, expectBanner: 'esmtp postfix' },
      { allowlist: LOOPBACK_ALLOWED },
    );
    assert.equal(insensitive.outcome, 'healthy', 'la casse de la bannière est fixée par le protocole');

    const wrong = await getMonitorProbe('tcp').run(
      { host: '127.0.0.1', port, expectBanner: 'SSH-2.0' },
      { allowlist: LOOPBACK_ALLOWED },
    );
    assert.equal(wrong.outcome, 'unhealthy', 'le port répond, mais pas le bon service');
    assert.match(wrong.detail ?? '', /SSH-2\.0/);
  } finally {
    server.close();
  }
});

test("un service muet est sain sans bannière attendue, en échec avec", async () => {
  // PostgreSQL, MySQL, HTTP : le client parle en premier. Le port accepte, rien
  // n'est annoncé. Les deux verdicts sont justes, et ils diffèrent.
  const server = await listen(() => {});
  const port = portOf(server);
  try {
    const bare = await getMonitorProbe('tcp').run(
      { host: '127.0.0.1', port },
      { allowlist: LOOPBACK_ALLOWED },
    );
    assert.equal(bare.outcome, 'healthy');

    const expecting = await getMonitorProbe('tcp').run(
      { host: '127.0.0.1', port, expectBanner: 'PostgreSQL', timeoutMs: 1_000 },
      { allowlist: LOOPBACK_ALLOWED },
    );
    assert.equal(expecting.outcome, 'unhealthy');
    assert.match(expecting.detail ?? '', /rien annoncé/);
    assert.equal(typeof expecting.metrics.connectMs, 'number', 'la connexion, elle, a réussi');
  } finally {
    server.close();
  }
});

// ─── dns : le schéma ──────────────────────────────────────────────────────────

test('une sonde DNS se configure avec un nom et un type', () => {
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

test("une valeur attendue mal écrite est refusée à la saisie, pas tous les quarts d'heure", () => {
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
  assert.equal(mx.ok, false, 'un MX sans priorité ne se compare pas');
  assert.match(mx.ok ? '' : mx.error.issues[0]?.message ?? '', /priorité/);

  const good = safeParseMonitorConfig('dns', {
    name: 'exemple.fr',
    recordType: 'MX',
    expected: '10 mail.exemple.fr, 20 secours.exemple.fr',
  });
  assert.equal(good.ok, true);
});

test('un résolveur se déclare par son adresse, jamais par son nom', () => {
  assert.equal(
    safeParseMonitorConfig('dns', { name: 'exemple.fr', resolver: 'dns.google' }).ok,
    false,
  );
  assert.equal(safeParseMonitorConfig('dns', { name: 'exemple.fr', resolver: '9.9.9.9' }).ok, true);
  assert.equal(
    safeParseMonitorConfig('dns', { name: 'exemple.fr', resolver: '169.254.53.53' }).ok,
    false,
    'un résolveur en lien-local est refusé comme toute autre cible de connexion',
  );
});

test('les types utiles sont proposés, SOA et PTR sont écartés', () => {
  const definition = monitorTypeDefinition('dns');
  const field = definition.fields.find((entry) => entry.key === 'recordType');
  assert.ok(field && field.kind === 'select');
  const offered = field.kind === 'select' ? field.options.map((option) => option.value) : [];
  assert.deepEqual(offered, ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'CAA', 'SRV']);
  assert.equal(offered.includes('SOA'), false, 'le numéro de série bouge à chaque édition');
  assert.equal(safeParseMonitorConfig('dns', { name: 'exemple.fr', recordType: 'SOA' }).ok, false);
});

// ─── dns : la comparaison, là où tout se joue ─────────────────────────────────

test("l'ordre n'est pas du signal — un résolveur permute ses réponses", () => {
  const comparison = compareDnsRecords({
    type: 'MX',
    expected: ['10 mail1.exemple.fr', '20 mail2.exemple.fr'],
    actual: ['20 mail2.exemple.fr', '10 mail1.exemple.fr'],
    match: 'exact',
  });
  assert.equal(comparison.ok, true, 'un comparateur naïf alerterait à chaque mesure');
  assert.deepEqual(comparison.missing, []);
  assert.deepEqual(comparison.unexpected, []);
});

test("la casse d'un nom n'est pas du signal, ni le point final", () => {
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
      // Certains résolveurs mélangent la casse à dessein (0x20 encoding).
      expected: ['ns1.exemple.fr', 'ns2.exemple.fr'],
      actual: ['NS2.ExEmPlE.fr.', 'nS1.exemple.FR.'],
      match: 'exact',
    }).ok,
    true,
  );
});

test("la casse d'un TXT est du signal — une clé DKIM distingue aB de Ab", () => {
  const comparison = compareDnsRecords({
    type: 'TXT',
    expected: ['v=DKIM1; p=MIGfMA0GCSqAb'],
    actual: ['v=DKIM1; p=MIGfMA0GCSqaB'],
    match: 'exact',
  });
  assert.equal(comparison.ok, false, 'replier la casse ici créerait une fausse égalité');
});

test("la forme d'écriture d'une adresse n'est pas du signal", () => {
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

test('une valeur absente est signalée, et nommée', () => {
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

test("un enregistrement ajouté est une anomalie en « exact », toléré en « au moins »", () => {
  const input = {
    type: 'A' as const,
    expected: ['203.0.113.7'],
    actual: ['203.0.113.7', '198.51.100.9'],
  };
  const strict = compareDnsRecords({ ...input, match: 'exact' });
  assert.equal(strict.ok, false, "l'ajout est la signature d'un détournement");
  assert.deepEqual(strict.unexpected, ['198.51.100.9']);

  const loose = compareDnsRecords({ ...input, match: 'contains' });
  assert.equal(loose.ok, true);
  assert.deepEqual(loose.unexpected, []);
});

test('la priorité fait partie du MX — le secours devenu principal est un incident', () => {
  const comparison = compareDnsRecords({
    type: 'MX',
    expected: ['10 mail1.exemple.fr', '20 mail2.exemple.fr'],
    actual: ['20 mail1.exemple.fr', '10 mail2.exemple.fr'],
    match: 'exact',
  });
  assert.equal(comparison.ok, false, 'les hôtes sont les mêmes, la configuration non');
});

test("l'étiquette d'un CAA est insensible à la casse, comme le nom de l'autorité", () => {
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

test('un SRV se compare sur ses quatre champs', () => {
  assert.equal(dnsComparisonKey('SRV', '10 5 5269 XMPP.exemple.fr.'), '10 5 5269 xmpp.exemple.fr');
  assert.equal(
    compareDnsRecords({
      type: 'SRV',
      expected: ['10 5 5269 xmpp.exemple.fr'],
      actual: ['10 5 5222 xmpp.exemple.fr'],
      match: 'exact',
    }).ok,
    false,
    'le port change où va le trafic',
  );
});

test('les morceaux entre guillemets de dig se recollent', () => {
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

test('la virgule sépare les valeurs, sauf pour TXT où elle est de la donnée', () => {
  assert.deepEqual(parseExpectedRecords('A', '203.0.113.7, 203.0.113.8'), [
    '203.0.113.7',
    '203.0.113.8',
  ]);
  assert.deepEqual(parseExpectedRecords('TXT', 'v=spf1 ip4:a,ip4:b ~all'), [
    'v=spf1 ip4:a,ip4:b ~all',
  ]);
  assert.deepEqual(parseExpectedRecords('TXT', 'un\ndeux'), ['un', 'deux']);
  // Deux écritures de la même valeur ne comptent qu'une fois, sinon un
  // « exactement ces valeurs » deviendrait insatisfiable.
  assert.deepEqual(parseExpectedRecords('NS', 'ns1.exemple.fr, NS1.exemple.fr.'), [
    'ns1.exemple.fr',
  ]);
});

test('la forme des valeurs attendues est contrôlée par type', () => {
  assert.equal(validateDnsRecordValue('A', '203.0.113.7'), null);
  assert.ok(validateDnsRecordValue('A', '2001:db8::1'), 'une IPv6 dans un A');
  assert.equal(validateDnsRecordValue('AAAA', '2001:db8::1'), null);
  assert.equal(validateDnsRecordValue('CAA', '0 issue letsencrypt.org'), null);
  assert.ok(validateDnsRecordValue('CAA', 'issue letsencrypt.org'), 'drapeaux manquants');
  assert.equal(validateDnsRecordValue('TXT', 'v=spf1 ~all'), null);
});

test('un domaine qui porte dix-sept TXT ne produit pas une alerte de deux kilooctets', () => {
  const actual = Array.from({ length: 17 }, (_, index) => `verification-${index}=${'x'.repeat(60)}`);
  const comparison = compareDnsRecords({
    type: 'TXT',
    expected: ['v=spf1 ~all'],
    actual,
    match: 'exact',
  });
  const message = describeDnsComparison(comparison);
  assert.equal(comparison.unexpected.length, 17);
  assert.ok(message.length < 600, `message de ${message.length} caractères`);
  assert.match(message, /17 au total/);
});

// ─── dns : le verdict d'une interrogation ─────────────────────────────────────

test('un nom qui ne résout pas est « unhealthy », pas « unreachable »', async () => {
  // Le résolveur a répondu : on a bien regardé, et la réponse n'est pas celle
  // attendue. `unreachable` voudrait dire « je n'ai pas pu regarder ».
  const result = await getMonitorProbe('dns').run(
    { name: 'nexistepas.pupitre-test.invalid', recordType: 'A', timeoutMs: 3_000 },
    { allowlist: NOTHING_ALLOWED },
  );
  assert.equal(result.outcome, 'unhealthy');
  assert.equal(result.metrics.recordCount, 0);
});

test('un résolveur interne non autorisé est refusé, sans interroger quoi que ce soit', async () => {
  const result = await getMonitorProbe('dns').run(
    { name: 'exemple.fr', recordType: 'A', resolver: '10.0.0.53' },
    { allowlist: NOTHING_ALLOWED },
  );
  assert.equal(result.outcome, 'unreachable');
  assert.match(result.detail ?? '', /résolveur refusé/);
  assert.match(result.detail ?? '', /MONITOR_ALLOWED_CIDRS/);
});

// ─── cadence ──────────────────────────────────────────────────────────────────

test('la cadence de chaque type dit ce qu’il coûte à l’autre bout', () => {
  // Un port TCP tombe aussi vite qu'un site : même plancher que HTTP.
  assert.equal(MONITOR_TYPES.tcp.minIntervalSeconds, MONITOR_TYPES.http.minIntervalSeconds);
  // Le DNS, non : sous le TTL on interroge son propre cache, et un résolveur
  // public est une ressource partagée qu'on ne paie pas.
  assert.equal(MONITOR_TYPES.dns.minIntervalSeconds, 300);
  assert.ok(MONITOR_TYPES.dns.minIntervalSeconds > MONITOR_TYPES.tcp.minIntervalSeconds);
});

test("les cadences retenues existent dans le sélecteur de l'écran", () => {
  // `apps/web` propose une liste figée d'intervalles ; un type dont le défaut
  // n'y figure pas afficherait une valeur que l'utilisateur ne voit pas.
  const offered = new Set([30, 60, 300, 900, 3_600, 6 * 3_600, 12 * 3_600, 86_400]);
  for (const type of ['tcp', 'dns'] as const) {
    assert.ok(offered.has(MONITOR_TYPES[type].minIntervalSeconds), `${type} : minimum absent`);
    assert.ok(offered.has(MONITOR_TYPES[type].defaultIntervalSeconds), `${type} : défaut absent`);
  }
});

test("les deux types n'utilisent que des formes de champ déjà rendues par l'écran", () => {
  // La preuve que « ajouter un type ne touche pas apps/web » : aucun `kind`
  // inédit, donc rien à ajouter au rendu des formulaires.
  const known = new Set(['url', 'host', 'text', 'number', 'select']);
  for (const type of ['tcp', 'dns'] as const) {
    for (const field of monitorTypeDefinition(type).fields) {
      assert.ok(known.has(field.kind), `${type}.${field.key} : forme de champ inédite`);
    }
  }
});

// ─── machine à états, sur des séquences réalistes ─────────────────────────────

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

test('un délai DNS isolé ne réveille personne', () => {
  // Une interrogation qui expire de temps en temps est la vie normale d'un
  // résolveur, pas un incident.
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

test('une propagation DNS se lit en une panne puis un rétablissement', () => {
  // Le A change, la sonde le voit `unhealthy` le temps que la zone se propage,
  // puis quelqu'un met la valeur attendue à jour.
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
  assert.deepEqual(transitions, ['down', 'up'], 'une panne, une alerte, un rétablissement');
});

test('un détournement de NS confirmé ouvre un incident unique', () => {
  const { state, transitions } = play(
    ['healthy', ...Array.from({ length: 20 }, () => 'unhealthy' as MonitorOutcome)],
  );
  assert.equal(state.status, 'unhealthy');
  assert.deepEqual(transitions, ['down'], 'vingt mesures, une alerte');
  assert.equal(state.consecutiveFailures, 20);
});

test('un service TCP qui redémarre : injoignable, puis muet, puis sain', () => {
  // Séquence réelle d'un redémarrage de conteneur avec bannière attendue : le
  // port refuse, puis il accepte sans être prêt à s'annoncer, puis tout va bien.
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

test("la nature de l'échec se met à jour sans rouvrir d'incident", () => {
  const { state, transitions } = play([
    'healthy',
    'unreachable',
    'unreachable',
    'unreachable',
    'unhealthy',
    'unreachable',
  ]);
  assert.equal(state.status, 'unreachable');
  assert.deepEqual(transitions, ['down'], 'le port passe de fermé à muet : toujours la même panne');
});
