/**
 * Harnais d'exécution des sondes `tcp` et `dns`, **contre de vraies cibles**.
 *
 *     pnpm --filter @pupitre/core exec tsx test/probes-live.ts
 *
 * Ce n'est pas un test unitaire et ça ne tourne pas dans `pnpm test` : ça sort
 * du réseau, donc ça échoue dans un tunnel de train, et un test qui échoue pour
 * une raison qui n'est pas le code est un test qu'on finit par ignorer. C'est
 * un harnais : on le lance, on lit ce qu'il affiche, on juge.
 *
 * Il vérifie ce qu'aucun test hors-ligne ne peut vérifier : que la sonde parle
 * bien aux vraies piles réseau — un vrai résolveur, un vrai service qui
 * annonce une bannière, un vrai port fermé — et que la garde SSRF tient face à
 * de vraies adresses.
 *
 * Les cibles TCP sont les conteneurs de la pile de développement, joints depuis
 * le poste par les ports publiés sur le bouclage. La liste d'autorisation du
 * harnais ouvre donc `127.0.0.0/8` — exactement ce que `MONITOR_ALLOWED_CIDRS`
 * ferait en production pour un parc interne, et le harnais montre juste après
 * que sans cette ligne, tout est refusé.
 */
import { parseCidrList, type CheckResult } from '../src/monitoring.js';
import { getMonitorProbe } from '../src/probe/index.js';

const LOOPBACK = parseCidrList('127.0.0.0/8');
const NOTHING = parseCidrList(undefined);

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const DIM = '\u001b[2m';
const OFF = '\u001b[0m';

function badge(result: CheckResult): string {
  if (result.outcome === 'healthy') return `${GREEN}sain       ${OFF}`;
  if (result.outcome === 'unhealthy') return `${YELLOW}dégradé    ${OFF}`;
  return `${RED}injoignable${OFF}`;
}

function show(result: CheckResult): void {
  const metrics = Object.entries(result.metrics)
    .filter(([, value]) => value !== null && value !== '')
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('  ');
  console.log(`   ${badge(result)} ${result.detail ?? ''}`);
  if (metrics !== '') console.log(`   ${DIM}${metrics}${OFF}`);
}

async function probe(
  title: string,
  type: 'tcp' | 'dns',
  config: Record<string, unknown>,
  allowlist = LOOPBACK,
): Promise<void> {
  console.log(`\n▸ ${title}`);
  console.log(`   ${DIM}${JSON.stringify(config)}${OFF}`);
  const started = performance.now();
  const result = await getMonitorProbe(type).run(config, { allowlist });
  show(result);
  console.log(`   ${DIM}mesuré en ${Math.round(performance.now() - started)} ms${OFF}`);
}

function section(title: string): void {
  console.log(`\n\n${'═'.repeat(78)}\n  ${title}\n${'═'.repeat(78)}`);
}

async function main(): Promise<void> {
  section('TCP — la pile de développement, telle qu’elle tourne');

  await probe('PostgreSQL, port publié sur le bouclage', 'tcp', {
    host: '127.0.0.1',
    port: 5433,
  });
  await probe(
    'PostgreSQL avec une bannière attendue — le client parle en premier, rien ne vient',
    'tcp',
    { host: '127.0.0.1', port: 5433, expectBanner: 'PostgreSQL', timeoutMs: 2_000 },
  );
  await probe('Redis, port publié sur le bouclage', 'tcp', { host: '127.0.0.1', port: 6380 });
  await probe('La cible SSH de test — un service qui, lui, s’annonce', 'tcp', {
    host: '127.0.0.1',
    port: 2222,
    expectBanner: 'SSH-2.0',
  });
  await probe('La même, avec la mauvaise bannière attendue', 'tcp', {
    host: '127.0.0.1',
    port: 2222,
    expectBanner: '220 ESMTP',
  });
  await probe('Un port fermé', 'tcp', { host: '127.0.0.1', port: 9 });
  await probe('Une adresse publique qui filtre — le délai, pas le refus', 'tcp', {
    host: 'example.com',
    port: 9,
    timeoutMs: 3_000,
  }, NOTHING);
  await probe('Un port public qui répond', 'tcp', { host: 'example.com', port: 443 }, NOTHING);

  section('TCP — la garde SSRF, sur de vraies adresses');

  await probe(
    'Le service de métadonnées d’un cloud — refusé quelle que soit la liste',
    'tcp',
    { host: '169.254.169.254', port: 80 },
    parseCidrList('0.0.0.0/0'),
  );
  await probe(
    'Le même PostgreSQL, mais sans MONITOR_ALLOWED_CIDRS',
    'tcp',
    { host: '127.0.0.1', port: 5433 },
    NOTHING,
  );
  await probe('Une plage privée non listée', 'tcp', { host: '10.0.0.5', port: 22 }, NOTHING);
  await probe('« localhost », refusé par son nom', 'tcp', { host: 'localhost', port: 5433 });

  section('DNS — des noms publics stables');

  await probe('Présence : le A de example.com existe-t-il', 'dns', {
    name: 'example.com',
    recordType: 'A',
  });
  await probe('Les NS de root-servers.net — la délégation la plus stable du monde', 'dns', {
    name: 'iana.org',
    recordType: 'NS',
  });
  await probe('Les MX de gmail.com, comparés dans le désordre', 'dns', {
    name: 'gmail.com',
    recordType: 'MX',
    expected:
      '40 alt4.gmail-smtp-in.l.google.com, 5 gmail-smtp-in.l.google.com, 30 alt3.gmail-smtp-in.l.google.com, 10 alt1.gmail-smtp-in.l.google.com, 20 alt2.gmail-smtp-in.l.google.com',
  });
  await probe('Le SPF de google.com, régime « au moins ces valeurs »', 'dns', {
    name: 'google.com',
    recordType: 'TXT',
    expected: 'v=spf1 include:_spf.google.com ~all',
    match: 'contains',
  });
  await probe('Le même SPF en régime « exactement » — tous les autres TXT sont en trop', 'dns', {
    name: 'google.com',
    recordType: 'TXT',
    expected: 'v=spf1 include:_spf.google.com ~all',
    match: 'exact',
  });
  await probe('Le CAA de google.com, avec la valeur attendue', 'dns', {
    name: 'google.com',
    recordType: 'CAA',
    expected: '0 ISSUE PKI.goog',
  });
  await probe('Un AAAA écrit sous une autre forme que celle du résolveur', 'dns', {
    name: 'one.one.one.one',
    recordType: 'AAAA',
    expected: '2606:4700:4700:0000:0000:0000:0000:1111, 2606:4700:4700::1001',
  });
  await probe('Une valeur attendue fausse — ce que voit l’exploitant en alerte', 'dns', {
    name: 'example.com',
    recordType: 'A',
    expected: '203.0.113.7',
  });
  await probe('Un nom qui n’existe pas (NXDOMAIN garanti, TLD réservé)', 'dns', {
    name: 'ceci-nexiste-vraiment-pas.invalid',
    recordType: 'A',
  });
  await probe('Un sous-domaine inexistant sous un domaine qui existe', 'dns', {
    name: 'ceci-nexiste-vraiment-pas.example.com',
    recordType: 'A',
  });
  await probe('Un nom qui existe sans enregistrement du type demandé', 'dns', {
    name: 'example.com',
    recordType: 'SRV',
  });

  section('DNS — le résolveur, seul endpoint que la garde contrôle');

  await probe('Résolveur du système (celui du conteneur, ou du poste)', 'dns', {
    name: 'example.com',
    recordType: 'A',
  });
  await probe('Résolveur public déclaré — ce que voit le monde, sans le cache local', 'dns', {
    name: 'example.com',
    recordType: 'A',
    resolver: '1.1.1.1',
  });
  await probe(
    'Un résolveur interne non listé — refusé avant la moindre interrogation',
    'dns',
    { name: 'example.com', recordType: 'A', resolver: '10.0.0.53' },
    NOTHING,
  );

  console.log('');
}

await main();
