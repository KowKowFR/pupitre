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
 * Les deux sondes ajoutées avec la supervision de sites : mot-clé et expiration de
 * domaine.
 *
 * Deux familles d'épreuves, et la séparation est volontaire :
 *
 *   • **Sans réseau** — la recherche de mot-clé, la lecture d'une réponse RDAP
 *     réelle figée en fixture, le jugement. Ce sont des fonctions pures, elles
 *     doivent passer sur une machine débranchée et ne jamais dépendre d'un
 *     registre tiers.
 *   • **Sur un serveur local** — la garde SSRF de la sonde de mot-clé, y compris
 *     à chaque saut de redirection. C'est la seule façon de *vérifier* qu'elle
 *     hérite de la garde plutôt que de l'affirmer.
 */

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

// ─── mot-clé : la recherche ───────────────────────────────────────────────────

test('le mode souple ignore la casse, les accents et les espaces', () => {
  const page = 'Bienvenue, veuillez vous  CONNECTER à votre espace';
  assert.equal(containsKeyword(page, 'connecter', 'lenient'), true);
  assert.equal(containsKeyword(page, 'vous connecter', 'lenient'), true, 'double espace écrasé');
  assert.equal(containsKeyword('Déjà inscrit ?', 'deja inscrit', 'lenient'), true, 'accents pliés');
  assert.equal(containsKeyword('Deja inscrit ?', 'déjà inscrit', 'lenient'), true, 'et dans l’autre sens');
});

test("l'espace insécable ne réveille personne à trois heures du matin", () => {
  // Le cas qui motive le mode souple : un `&nbsp;` avant un « : » à la française
  // n'est pas une panne, et une sonde qui le prend pour une panne finit ignorée.
  const page = 'Statut : en ligne';
  assert.equal(containsKeyword(page, 'Statut : en ligne', 'lenient'), true);
  assert.equal(containsKeyword(page, 'Statut : en ligne', 'strict'), false);
  // L'espace fine insécable, celle des unités, se plie aussi.
  assert.equal(containsKeyword('12 345 comptes', '12 345 comptes', 'lenient'), true);
});

test('le mode strict compare au caractère près', () => {
  assert.equal(containsKeyword('{"status":"ok"}', '"status":"ok"', 'strict'), true);
  assert.equal(containsKeyword('{"status":"OK"}', '"status":"ok"', 'strict'), false);
  assert.equal(containsKeyword('{"status":"OK"}', '"status":"ok"', 'lenient'), true);
});

test('le pliage est symétrique et idempotent', () => {
  assert.equal(foldForSearch('  ÉTÉ  2026 '), 'ete 2026');
  assert.equal(foldForSearch(foldForSearch('ÉTÉ')), foldForSearch('ÉTÉ'));
});

test('le dépouillement retire ce qu’un visiteur ne lit pas', () => {
  const html =
    '<!-- TODO: Erreur 500 à corriger -->' +
    '<script>var msg = "Erreur 500";</script>' +
    '<style>.a{content:"Erreur 500"}</style>' +
    '<img alt="Erreur 500"><p>Tout va bien</p>';
  const text = stripMarkup(html);
  assert.equal(containsKeyword(text, 'Erreur 500', 'lenient'), false, 'aucune occurrence visible');
  assert.equal(containsKeyword(text, 'Tout va bien', 'lenient'), true);
  // Sur le brut, les quatre occurrences invisibles feraient sonner à tort.
  assert.equal(containsKeyword(html, 'Erreur 500', 'lenient'), true);
});

test('le dépouillement rend les entités et ne colle pas les mots', () => {
  assert.equal(foldForSearch(stripMarkup('<b>Se</b><i>connecter</i>')), 'se connecter');
  assert.equal(stripMarkup('<p>Caf&eacute; &amp; th&#233;</p>').includes('&'), true);
  assert.equal(containsKeyword(stripMarkup('<p>Caf&#233; &amp; th&#233;</p>'), 'café & thé', 'lenient'), true);
});

// ─── mot-clé : la configuration ───────────────────────────────────────────────

test('une sonde de mot-clé sans mot-clé est refusée', () => {
  const empty = keywordConfigSchema.safeParse({ url: 'https://exemple.fr/' });
  assert.equal(empty.success, false);
  assert.match(
    empty.success ? '' : (empty.error.issues[0]?.message ?? ''),
    /au moins/,
    'le message doit dire quoi remplir',
  );
});

test('présence seule, absence seule, ou les deux', () => {
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
  assert.equal(both.success && both.data.matching, 'lenient', 'souple par défaut');
  assert.equal(both.success && both.data.scope, 'raw', 'brut par défaut');
  assert.equal(both.success && both.data.maxKib, 512);
});

test('la borne de lecture est bornée des deux côtés', () => {
  const base = { url: 'https://exemple.fr/', mustContain: 'x' };
  assert.equal(keywordConfigSchema.safeParse({ ...base, maxKib: 8 }).success, false, 'trop bas');
  assert.equal(keywordConfigSchema.safeParse({ ...base, maxKib: 4096 }).success, false, 'trop haut');
  assert.equal(keywordConfigSchema.safeParse({ ...base, maxKib: 16 }).success, true);
  assert.equal(keywordConfigSchema.safeParse({ ...base, maxKib: 2048 }).success, true);
});

test('la garde SSRF s’applique à la configuration du mot-clé comme aux autres', () => {
  assert.equal(safeParseMonitorConfig('keyword', { url: 'http://localhost:3000/', mustContain: 'x' }).ok, false);
  assert.equal(safeParseMonitorConfig('keyword', { url: 'file:///etc/passwd', mustContain: 'x' }).ok, false);
  assert.equal(
    safeParseMonitorConfig('keyword', { url: 'https://admin:secret@exemple.fr/', mustContain: 'x' }).ok,
    false,
  );
});

// ─── mot-clé : la sonde, contre un serveur local ──────────────────────────────

/**
 * Le serveur d'épreuve est sur 127.0.0.1, et la sonde ne l'atteint que parce
 * que le test ouvre explicitement `127.0.0.0/8` dans la liste d'autorisation —
 * ce qui est déjà une démonstration : sans cette ligne, rien ne passe.
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

test('la sonde trouve un mot-clé accentué sur une page servie en windows-1252', async () => {
  // Supposer UTF-8 partout ferait échouer « Connecté » sur un site français
  // encore servi en latin-1 — une fausse panne pour un accent.
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

test('un texte interdit présent fait échouer la sonde, et le dit', async () => {
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
  assert.equal(result.metrics.httpStatus, 200, 'un 200 : c’est bien le mot-clé qui a tranché');
});

test('une coupure ne se fait jamais passer pour une absence', async () => {
  // Le mot-clé est au-delà du plafond de lecture : la sonde échoue — elle ne
  // peut pas prouver la présence — mais la phrase dit qu'elle a coupé.
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

test('un « sain » sur réponse coupée dit ce qu’il n’a pas pu vérifier', async () => {
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

test('la sonde de mot-clé hérite de la garde SSRF à chaque redirection', async () => {
  // Le point qui compte : contrôler l'adresse de départ ne suffit pas. Une URL
  // autorisée qui renvoie un 302 vers le service de métadonnées doit s'arrêter
  // au deuxième saut, pas au premier.
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
  assert.match(result.detail ?? '', /aucune liste/, 'le lien-local ne s’autorise jamais');
});

test('une redirection vers une plage non autorisée est refusée aussi', async () => {
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

test('sans plage autorisée, la sonde n’atteint même pas le serveur local', async () => {
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

test('le code attendu est vérifié avant le mot-clé', async () => {
  // Une page 404 peut très bien contenir le mot attendu.
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

test('la connaissance des TLD est datée, pour qu’on sache quand elle vieillit', () => {
  assert.match(RDAP_TLD_KNOWLEDGE_DATE, /^\d{4}-\d{2}-\d{2}$/);
});

test('les TLD sans RDAP sont connus comme tels', () => {
  // Mesuré sur les fichiers de l'IANA : 1 200 TLD sur 1 438 publient un RDAP.
  for (const tld of ['io', 'de', 'co', 'eu', 'ch', 'it', 'es', 'be', 'us', 'jp']) {
    assert.equal(tldPublishesRdap(tld), false, `.${tld} n'a pas de RDAP`);
  }
  for (const tld of ['arpa', 'edu', 'mil']) {
    assert.equal(tldPublishesRdap(tld), false, `.${tld} est un TLD de rôle`);
  }
});

test('les gTLD et les ccTLD listés en ont un, les IDN ne sont pas tranchés', () => {
  for (const tld of ['com', 'net', 'org', 'dev', 'app', 'solutions', 'fr', 'nl', 'uk', 'ca']) {
    assert.equal(tldPublishesRdap(tld), true, `.${tld} publie un RDAP`);
  }
  assert.equal(tldPublishesRdap('xn--p1ai'), null, 'on ne bloque jamais sur une ignorance');
});

test('un domaine sur un TLD sans RDAP est refusé à la création, avec le motif', () => {
  const refused = domainConfigSchema.safeParse({ domain: 'exemple.io' });
  assert.equal(refused.success, false);
  const message = refused.success ? '' : (refused.error.issues[0]?.message ?? '');
  assert.match(message, /\.io/);
  assert.match(message, /RDAP/, 'le motif doit être lisible sans lire le code');
  // Refuser tout de suite vaut mieux qu'un voyant rouge permanent : l'absence
  // de service RDAP n'est pas une panne du domaine.
  assert.equal(domainConfigSchema.safeParse({ domain: 'exemple.fr' }).success, true);
  assert.equal(domainConfigSchema.safeParse({ domain: 'exemple.com' }).success, true);
});

test('la sonde de domaine veut un nom de domaine, pas une URL', () => {
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
    assert.equal(domainConfigSchema.safeParse({ domain: bad }).success, false, `« ${bad} » accepté`);
  }
});

test('le nom est normalisé sans être réécrit', () => {
  const parsed = domainConfigSchema.parse({ domain: '  Exemple.FR.  ' });
  assert.equal(parsed.domain, 'exemple.fr', 'casse et point final normalisés');
  // `www.` n'est pas retiré : deviner le domaine enregistrable demanderait la
  // Public Suffix List, et une correction invisible cache une erreur de saisie.
  assert.equal(domainConfigSchema.parse({ domain: 'www.exemple.fr' }).domain, 'www.exemple.fr');
  assert.equal(tldOf('sous.exemple.fr'), 'fr');
});

// ─── domaine : la liste d'amorçage ────────────────────────────────────────────

test('la liste d’amorçage de l’IANA se lit telle qu’elle est publiée', () => {
  const map = readBootstrap(fixture('iana-rdap-bootstrap-slice.json'));
  assert.equal(map.get('com'), 'https://rdap.verisign.com/com/v1/');
  assert.equal(map.get('fr'), 'https://rdap.nic.fr/');
  assert.equal(map.get('dev'), 'https://pubapi.registry.google/rdap/');
  assert.equal(map.get('io'), undefined);
});

test('une liste d’amorçage illisible rend une table vide, pas une exception', () => {
  assert.equal(readBootstrap({ services: 'pas un tableau' }).size, 0);
  assert.equal(readBootstrap(null).size, 0);
  // Une entrée servie en clair est ignorée : une réponse RDAP altérée en
  // transit dirait n'importe quoi sur une date d'expiration.
  assert.equal(readBootstrap({ services: [[['zz'], ['http://rdap.example/']]] }).size, 0);
});

// ─── domaine : lire une vraie réponse RDAP ────────────────────────────────────

test('une réponse RDAP réelle de Verisign se lit entièrement', () => {
  const facts = readRdapDomain(fixture('rdap-example-com.json'));
  assert.equal(facts.ldhName, 'example.com', 'le .com majuscule son nom, on le normalise');
  assert.equal(facts.expiresOn, '2027-08-13T04:00:00.000Z');
  assert.equal(facts.registeredOn, '1995-08-14T04:00:00.000Z');
  assert.equal(facts.registrar, 'RESERVED-Internet Assigned Numbers Authority');
  assert.deepEqual(facts.nameservers, ['elliott.ns.cloudflare.com', 'hera.ns.cloudflare.com']);
  // « client transfer prohibited » et « clientTransferProhibited » désignent la
  // même chose : on aplatit les deux formes.
  assert.ok(facts.statuses.includes('clienttransferprohibited'));
});

test('une réponse RDAP réelle de l’AFNIC se lit aussi, avec ses particularités', () => {
  const facts = readRdapDomain(fixture('rdap-afnic-fr.json'));
  assert.equal(facts.ldhName, 'afnic.fr');
  assert.equal(facts.expiresOn, '2029-07-18T08:26:59.000Z');
  assert.equal(facts.registrar, 'Registry Operations');
  assert.deepEqual(facts.nameservers, ['g.ext.nic.fr', 'ns1.nic.fr', 'ns2.nic.fr', 'ns3.nic.fr']);
  // La particularité qui compte : l'AFNIC n'annonce qu'« active ». Exiger le
  // verrou de transfert sur un .fr échouerait donc, d'où le défaut à « off ».
  assert.deepEqual(facts.statuses, ['active']);
});

test('une réponse hors-forme ne fait pas tomber la lecture', () => {
  const facts = readRdapDomain({ objectClassName: 'domain' });
  assert.equal(facts.expiresOn, null);
  assert.deepEqual(facts.nameservers, []);
  assert.equal(readRdapDomain('pas du JSON RDAP').registrar, null);
});

// ─── domaine : le jugement ────────────────────────────────────────────────────

const NOW = new Date('2026-09-13T12:00:00Z');
const baseConfig = (over: Partial<DomainConfig> = {}): DomainConfig =>
  domainConfigSchema.parse({ domain: 'exemple.fr', ...over });

test('un domaine loin de son échéance est sain et muet', () => {
  const facts = readRdapDomain(fixture('rdap-afnic-fr.json'));
  const verdict = judgeDomain(facts, baseConfig(), NOW);
  assert.equal(verdict.outcome, 'healthy');
  assert.equal(verdict.detail, null);
  assert.equal(verdict.daysRemaining, 1038);
});

test('sous le préavis, la sonde échoue — et la phrase dit « en danger », pas « en panne »', () => {
  const facts = readRdapDomain({
    events: [{ eventAction: 'expiration', eventDate: '2026-09-25T00:00:00Z' }],
  });
  const verdict = judgeDomain(facts, baseConfig({ warnDays: 30 }), NOW);
  assert.equal(verdict.outcome, 'unhealthy');
  assert.equal(verdict.daysRemaining, 11);
  assert.match(verdict.detail ?? '', /expire dans 11 jours \(le 25\/09\/2026\)/);
  assert.match(verdict.detail ?? '', /préavis de 30 jours/);
  // Un préavis plus court laisse le même domaine sain : c'est un réglage, pas
  // une propriété du domaine.
  assert.equal(judgeDomain(facts, baseConfig({ warnDays: 7 }), NOW).outcome, 'healthy');
});

test('un domaine expiré se compte en jours écoulés', () => {
  const facts = readRdapDomain({
    events: [{ eventAction: 'expiration', eventDate: '2026-09-01T00:00:00Z' }],
  });
  const verdict = judgeDomain(facts, baseConfig(), NOW);
  assert.equal(verdict.outcome, 'unhealthy');
  assert.match(verdict.detail ?? '', /expiré depuis 13 jours/);
});

test('un registre sans date d’expiration ne rend pas la sonde malade', () => {
  // Le registre a répondu et connaît le domaine : il *est* enregistré. Ne pas
  // publier de date est une limite de ce registre, pas une panne — mais on le
  // dit, sinon on laisse croire qu'on surveille l'expiration.
  const verdict = judgeDomain(readRdapDomain({ status: ['active'] }), baseConfig(), NOW);
  assert.equal(verdict.outcome, 'healthy');
  assert.equal(verdict.daysRemaining, null);
  assert.match(verdict.detail ?? '', /ne publie pas de date d’expiration/);
});

test('un changement de registrar fait échouer la sonde — c’est à ça qu’il sert', () => {
  const facts = readRdapDomain(fixture('rdap-example-com.json'));
  assert.equal(judgeDomain(facts, baseConfig({ expectedRegistrar: 'Internet Assigned' }), NOW).outcome, 'healthy');
  // Comparaison tolérante : « OVH » doit reconnaître « OVH SAS ».
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

test('un déplacement des serveurs de noms se voit', () => {
  const facts = readRdapDomain(fixture('rdap-example-com.json'));
  assert.equal(
    judgeDomain(facts, baseConfig({ expectedNameserverSuffix: 'cloudflare.com' }), NOW).outcome,
    'healthy',
  );
  const moved = judgeDomain(facts, baseConfig({ expectedNameserverSuffix: 'ovh.net' }), NOW);
  assert.equal(moved.outcome, 'unhealthy');
  assert.match(moved.detail ?? '', /délégation actuelle : elliott\.ns\.cloudflare\.com/);
});

test('le verrou de transfert n’est exigé que si on le demande', () => {
  const afnic = readRdapDomain(fixture('rdap-afnic-fr.json'));
  assert.equal(judgeDomain(afnic, baseConfig(), NOW).outcome, 'healthy', 'off par défaut');
  const required = judgeDomain(afnic, baseConfig({ transferLock: 'required' }), NOW);
  assert.equal(required.outcome, 'unhealthy', '.fr n’annonce qu’« active »');
  assert.match(required.detail ?? '', /statuts : active/);

  const verisign = readRdapDomain(fixture('rdap-example-com.json'));
  assert.equal(judgeDomain(verisign, baseConfig({ transferLock: 'required' }), NOW).outcome, 'healthy');
});

test('plusieurs constats se disent ensemble, pas un seul', () => {
  // Une expiration proche *et* un registrar changé : n'en rendre qu'un ferait
  // disparaître l'autre du message d'alerte, et le second est le plus grave.
  const facts = readRdapDomain({
    events: [{ eventAction: 'expiration', eventDate: '2026-09-20T00:00:00Z' }],
    entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', 'Registrar Inconnu']]] }],
  });
  const verdict = judgeDomain(facts, baseConfig({ expectedRegistrar: 'OVH' }), NOW);
  assert.equal(verdict.outcome, 'unhealthy');
  assert.match(verdict.detail ?? '', /expire dans 6 jours/);
  assert.match(verdict.detail ?? '', /Registrar Inconnu/);
});

// ─── la sonde HTTP, après l'extraction de la boucle gardée ────────────────────

/**
 * La boucle de requête a déménagé dans `probe/fetch.ts`, partagée par HTTP, le
 * mot-clé et RDAP. Ces trois épreuves fixent le comportement de la sonde HTTP
 * pour que l'extraction reste une extraction, et pas un changement déguisé.
 */

test('la sonde HTTP rend toujours code, latence et adresse', async () => {
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

test('une boucle de redirection est un « répond mal », pas un « injoignable »', async () => {
  const url = await serve((_req, res) => {
    res.writeHead(302, { location: '/encore' });
    res.end();
  });
  const result = await httpProbe.run({ url: `${url}/` }, { allowlist: LOOPBACK, language: 'fr' });
  assert.equal(result.outcome, 'unhealthy', 'la cible a répondu — mal');
  assert.match(result.detail ?? '', /plus de 5 redirections/);
  assert.equal(result.metrics.httpStatus, 302);
  assert.equal(result.metrics.redirects, 5);
});

test("l'option mot-clé de la sonde HTTP reste une sous-chaîne exacte", async () => {
  const url = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<p>Se Connecter</p>');
  });
  // Volontairement intolérante : c'est le type `keyword` qui plie la casse.
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

test('on n’interroge pas un registre plus d’une fois par six heures', () => {
  // Un registre est un service public gratuit, et un domaine n'expire pas entre
  // deux minutes : la cadence minimale est une propriété du type.
  assert.equal(MONITOR_TYPES.domain.minIntervalSeconds, 6 * 3_600);
  assert.equal(MONITOR_TYPES.domain.defaultIntervalSeconds, 86_400);
  // Le mot-clé, lui, c'est la même requête que HTTP avec un peu de lecture.
  assert.equal(MONITOR_TYPES.keyword.minIntervalSeconds, MONITOR_TYPES.http.minIntervalSeconds);
});

// ─── certificat vu par les sondes HTTP ────────────────────────────────────────

test('certificat : jours restants arrondis vers le bas, et rien pour une page en clair', async () => {
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

test('certificat : les sondes HTTP et mot-clé déclarent ses deux mesures', () => {
  for (const type of ['http', 'keyword'] as const) {
    const keys = MONITOR_TYPES[type].metrics.map((metric) => metric.key);
    assert.ok(keys.includes('certDaysRemaining'), `${type} : jours restants absents`);
    assert.ok(keys.includes('certValidTo'), `${type} : date de fin absente`);
  }
});
