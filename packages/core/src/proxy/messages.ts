import { translator, type Translate, type Translated, type UiLanguage } from '../i18n.js';

/**
 * What reverse proxies say — installation, "Test", applying routes, a domain's
 * probes, testing a link —, in the instance's language. What is shared by all
 * is here; each proxy has its dictionary, which builds on this one.
 */
const fr = {
  'host.mkdirFailed': 'création impossible',
  'host.writeRefused': 'écriture refusée',
  'host.removeRefused': 'suppression refusée',

  'detect.none': 'aucun {proxy} sur cette machine',
  'detect.container': 'conteneur {name} : {summary}',
  'install.unavailable': 'installation « {option} » impossible sur cette machine',
  'install.portBusy': 'le port {ports} est déjà utilisé : un autre serveur web ou proxy tourne ici',
  'install.notHealthy': '{proxy} ne répond pas après son démarrage (état : {state})',
  'install.compose': 'docker compose up : {detail}',
  'state.unknown': 'inconnu',
  'uninstall.foreign': '{proxy} n’a pas été installé par Pupitre : il reste en place',
  'uninstall.stopped': 'conteneur arrêté',
  'check.answers': 'répond ({code})',
  'check.silent': 'rien n’écoute',
  'check.container': 'Conteneur {name}',
  'check.notFound': 'introuvable',
  noAnswer: 'pas de réponse',
  'apply.noUpstream': 'l’application n’expose rien que le proxy puisse joindre',

  'probe.unreadable': '{name} : aucune réponse lisible',
  'probe.silent': '{name} : le proxy ne répond pas sur ce port',
  'probe.unknownDomain': '{name} : le proxy ne connaît pas ce domaine ({code})',
  'probe.upstreamDown': '{name} : le proxy ne joint pas l’application ({code})',
  'probe.noRedirect': '{name} : la redirection vers HTTPS manque ({code})',
  'probe.ok': 'répond — {codes}',

  'reach.ok': 'connexion ouverte depuis « {proxy} » vers {where}',
  'reach.elsewhere':
    '{where} a répondu, mais ce n’est pas cette machine — l’adresse mène ailleurs (NAT, autre serveur ?)',
  'reach.cutOff':
    '{where} accepte la connexion puis la coupe sans réponse — ce n’est pas cette machine qui répond (proxy transparent, NAT, autre serveur ?)',
  'reach.refused':
    '{where} refuse la connexion depuis « {proxy} » — un pare-feu la rejette, ou l’adresse n’est pas celle de cette machine',
  'reach.timeout':
    'aucune réponse de {where} en {seconds} s depuis « {proxy} » — un pare-feu ou le groupe de sécurité de l’hébergeur bloque sans doute le passage',
  'reach.error': 'connexion impossible de « {proxy} » vers {where} (curl code {code})',
  'reach.noRoute': '« {proxy} » n’a aucune route vers {address}',
  'reach.route': 'route de « {proxy} » vers {address} : depuis {source}',
  'reach.noFreePort': 'aucun port libre dans {min}-{max} pour éprouver la connexion',
  'reach.noTool':
    'ni python3, ni perl, ni nc sur « {target} » : la connexion n’a pas pu être éprouvée, seule la route l’a été',
  'reach.cannotListen': 'impossible d’écouter sur {address}:{port} sur « {target} »',
  'reach.nat': 'arrivée vue de « {target} » : {source} (NAT entre les deux)',
  'reach.unknownSource':
    '{detail} — d’où il arrive n’a pas pu être relevé (ni python3 ni perl sur « {target} ») : le port des applications ne sera pas restreint au proxy',
  'reach.retry': '{detail} — nouvel essai sur un autre port',

  'hostname.empty': 'vide',
  'hostname.tooLong': 'plus de 253 caractères',
  'hostname.wildcard': 'les jokers ne sont pas pris en charge',
  'hostname.ip': 'une adresse IP n’est pas un domaine',
  'hostname.noDot': 'il faut au moins un point (exemple.fr)',
  'hostname.invalid': 'caractère ou libellé invalide',

  'describe.container': 'conteneur {name}',
  'describe.certificates': 'certificats {authority}',
  'describe.noAcme': 'sans ACME',
} as const;

const en: Translated<typeof fr> = {
  'host.mkdirFailed': 'cannot create it',
  'host.writeRefused': 'write refused',
  'host.removeRefused': 'removal refused',

  'detect.none': 'no {proxy} on this machine',
  'detect.container': 'container {name}: {summary}',
  'install.unavailable': 'installation “{option}” is not possible on this machine',
  'install.portBusy': 'port {ports} is already in use: another web server or proxy runs here',
  'install.notHealthy': '{proxy} does not answer after starting (state: {state})',
  'install.compose': 'docker compose up: {detail}',
  'state.unknown': 'unknown',
  'uninstall.foreign': '{proxy} was not installed by Pupitre: it stays in place',
  'uninstall.stopped': 'container stopped',
  'check.answers': 'answers ({code})',
  'check.silent': 'nothing is listening',
  'check.container': 'Container {name}',
  'check.notFound': 'not found',
  noAnswer: 'no answer',
  'apply.noUpstream': 'the application exposes nothing the proxy can reach',

  'probe.unreadable': '{name}: no readable answer',
  'probe.silent': '{name}: the proxy does not answer on this port',
  'probe.unknownDomain': '{name}: the proxy does not know this domain ({code})',
  'probe.upstreamDown': '{name}: the proxy cannot reach the application ({code})',
  'probe.noRedirect': '{name}: the redirect to HTTPS is missing ({code})',
  'probe.ok': 'answers — {codes}',

  'reach.ok': 'connection opened from “{proxy}” to {where}',
  'reach.elsewhere':
    '{where} answered, but it is not this machine — the address leads elsewhere (NAT, another server?)',
  'reach.cutOff':
    '{where} accepts the connection then drops it without answering — this machine is not the one answering (transparent proxy, NAT, another server?)',
  'reach.refused':
    '{where} refuses the connection from “{proxy}” — a firewall rejects it, or the address is not this machine’s',
  'reach.timeout':
    'no answer from {where} within {seconds} s from “{proxy}” — a firewall or the hosting provider’s security group is probably blocking it',
  'reach.error': 'cannot connect from “{proxy}” to {where} (curl code {code})',
  'reach.noRoute': '“{proxy}” has no route to {address}',
  'reach.route': 'route from “{proxy}” to {address}: from {source}',
  'reach.noFreePort': 'no free port in {min}-{max} to test the connection',
  'reach.noTool':
    'neither python3, perl nor nc on “{target}”: the connection could not be tested, only the route was',
  'reach.cannotListen': 'cannot listen on {address}:{port} on “{target}”',
  'reach.nat': 'arrival seen from “{target}”: {source} (NAT in between)',
  'reach.unknownSource':
    '{detail} — where it comes from could not be recorded (neither python3 nor perl on “{target}”): the applications’ port will not be restricted to the proxy',
  'reach.retry': '{detail} — trying another port',

  'hostname.empty': 'empty',
  'hostname.tooLong': 'more than 253 characters',
  'hostname.wildcard': 'wildcards are not supported',
  'hostname.ip': 'an IP address is not a domain',
  'hostname.noDot': 'at least one dot is required (example.com)',
  'hostname.invalid': 'invalid character or label',

  'describe.container': 'container {name}',
  'describe.certificates': '{authority} certificates',
  'describe.noAcme': 'without ACME',
};

export const proxyCopy = { fr, en };

export type ProxySay = Translate<typeof fr>;

export function proxySay(language: UiLanguage): ProxySay {
  return translator(proxyCopy, language);
}

/** "80 et 443", "80 and 443". */
export function listOf(items: readonly string[], language: UiLanguage): string {
  return new Intl.ListFormat(language, { type: 'conjunction' }).format(items);
}
