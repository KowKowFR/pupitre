import { translator, type Translate, type Translated, type UiLanguage } from '../i18n.js';

/**
 * What the monitoring probes say — a reading's `detail`, taken as is by the
 * screen and the alerts —, in the instance's language.
 */
const fr = {
  timeout: 'délai dépassé après {ms} ms',
  invalidConfig: 'configuration de sonde invalide : {issues}',
  noCertificate: 'aucun certificat présenté',
  yes: 'oui',
  no: 'non',

  'fetch.redirectRefused': 'redirection refusée : {reason}',
  'fetch.notHttps': '« {url} » n’est pas en https',
  'fetch.tooManyRedirects': 'plus de {max} redirections',
  'fetch.badRedirect': 'redirection illisible vers « {location} »',

  'http.status': 'code {status}, {expected} attendu',
  'http.keywordMissing': 'mot-clé « {keyword} » absent de la réponse',
  'http.keywordMissingTruncated': 'mot-clé « {keyword} » absent des {bytes} premiers octets',

  'keyword.cut': ' (réponse coupée à {kib} kio)',
  'keyword.missing': 'texte attendu « {text} » absent de la page{cut}',
  'keyword.forbidden': 'texte interdit « {text} » trouvé dans la page',
  'keyword.partial': 'absence du texte interdit vérifiée sur les {kib} premiers kio seulement',

  'tcp.silentBanner':
    'le port accepte la connexion mais n’a rien annoncé en {ms} ms — un service où le client parle en premier ne rend jamais de bannière',
  'tcp.closedSilently': 'le port accepte la connexion puis referme sans rien annoncer',
  'tcp.wrongBanner': 'bannière « {expected} » attendue, reçu « {banner} »',

  'tls.unreadableExpiry': 'date d’expiration illisible « {value} »',
  'tls.expired': {
    one: 'certificat expiré depuis {count} jour',
    other: 'certificat expiré depuis {count} jours',
  },
  'tls.notYetValid': 'certificat pas encore valide',
  'tls.expiresSoon': {
    one: 'certificat expire dans {count} jour, préavis réglé à {warnDays}',
    other: 'certificat expire dans {count} jours, préavis réglé à {warnDays}',
  },

  'dns.resolverRefused': 'résolveur refusé — {reason}',
  'dns.systemResolver': 'système ({servers})',
  'dns.nxdomain': 'le nom « {name} » n’existe pas (NXDOMAIN)',
  'dns.noRecord': '« {name} » n’a aucun enregistrement {type}',
  'dns.mismatch': '{type} de « {name} » : {comparison}',
  'dns.missing': { one: 'manquant : {values}', other: 'manquants : {values}' },
  'dns.unexpected': 'en trop : {values}',
  'dns.total': '{values}… ({count} au total)',

  'domain.noExpiry': 'ce registre ne publie pas de date d’expiration',
  'domain.expired': {
    one: 'domaine expiré depuis {count} jour (le {date})',
    other: 'domaine expiré depuis {count} jours (le {date})',
  },
  'domain.expiresSoon': {
    one: 'expire dans {count} jour (le {date}) — sous le préavis de {warnDays} jours',
    other: 'expire dans {count} jours (le {date}) — sous le préavis de {warnDays} jours',
  },
  'domain.noRegistrar':
    'ce registre ne publie pas de registrar — la comparaison n’a pas pu se faire',
  'domain.registrar':
    'registrar « {actual} », « {expected} » attendu — un transfert de domaine ressemble exactement à ça',
  'domain.noNameservers': 'ce registre ne publie pas les serveurs de noms',
  'domain.nameservers':
    'aucun serveur de noms ne finit par « {suffix} » — délégation actuelle : {nameservers}',
  'domain.noLock': 'le verrou de transfert n’est pas annoncé{statuses}',
  'domain.noStatuses': ' (ce registre ne publie aucun statut)',
  'domain.statuses': ' (statuts : {statuses})',
  'domain.noRdap':
    'le TLD « .{tld} » ne publie pas de service RDAP — cette sonde ne peut rien y constater, et un domaine sans RDAP n’est pas un domaine en panne : mieux vaut la supprimer',
  'domain.noRdapServer':
    'aucun serveur RDAP connu pour « .{tld} » — liste d’amorçage de l’IANA injoignable et TLD absent de l’amorce embarquée',
  'domain.registry': 'registre {server} : {detail}',
  'domain.unknown':
    'le registre {server} ne connaît pas « {domain} » — domaine expiré et purgé, ou nom qui n’est pas celui qui est enregistré (« exemple.fr », pas « www.exemple.fr »)',
  'domain.registryStatus':
    'le registre {server} a répondu {status} — c’est le registre, pas le domaine',
  'domain.unreadable': 'réponse illisible du registre {server} — ce n’est pas du JSON RDAP',

  'inspect.rdapUnreadable': 'réponse RDAP illisible',
  'webhook.status': 'le récepteur a répondu {status}',
} as const;

const en: Translated<typeof fr> = {
  timeout: 'timed out after {ms} ms',
  invalidConfig: 'invalid probe configuration: {issues}',
  noCertificate: 'no certificate presented',
  yes: 'yes',
  no: 'no',

  'fetch.redirectRefused': 'redirect refused: {reason}',
  'fetch.notHttps': '“{url}” is not https',
  'fetch.tooManyRedirects': 'more than {max} redirects',
  'fetch.badRedirect': 'unreadable redirect to “{location}”',

  'http.status': 'status {status}, {expected} expected',
  'http.keywordMissing': 'keyword “{keyword}” missing from the response',
  'http.keywordMissingTruncated': 'keyword “{keyword}” missing from the first {bytes} bytes',

  'keyword.cut': ' (response cut at {kib} KiB)',
  'keyword.missing': 'expected text “{text}” missing from the page{cut}',
  'keyword.forbidden': 'forbidden text “{text}” found in the page',
  'keyword.partial': 'absence of the forbidden text checked on the first {kib} KiB only',

  'tcp.silentBanner':
    'the port accepts the connection but announced nothing within {ms} ms — a service where the client speaks first never sends a banner',
  'tcp.closedSilently': 'the port accepts the connection then closes without announcing anything',
  'tcp.wrongBanner': 'banner “{expected}” expected, received “{banner}”',

  'tls.unreadableExpiry': 'unreadable expiry date “{value}”',
  'tls.expired': {
    one: 'certificate expired {count} day ago',
    other: 'certificate expired {count} days ago',
  },
  'tls.notYetValid': 'certificate not valid yet',
  'tls.expiresSoon': {
    one: 'certificate expires in {count} day, warning set at {warnDays}',
    other: 'certificate expires in {count} days, warning set at {warnDays}',
  },

  'dns.resolverRefused': 'resolver refused — {reason}',
  'dns.systemResolver': 'system ({servers})',
  'dns.nxdomain': 'name “{name}” does not exist (NXDOMAIN)',
  'dns.noRecord': '“{name}” has no {type} record',
  'dns.mismatch': '{type} of “{name}”: {comparison}',
  'dns.missing': { one: 'missing: {values}', other: 'missing: {values}' },
  'dns.unexpected': 'unexpected: {values}',
  'dns.total': '{values}… ({count} in all)',

  'domain.noExpiry': 'this registry does not publish an expiry date',
  'domain.expired': {
    one: 'domain expired {count} day ago (on {date})',
    other: 'domain expired {count} days ago (on {date})',
  },
  'domain.expiresSoon': {
    one: 'expires in {count} day (on {date}) — within the {warnDays}-day warning',
    other: 'expires in {count} days (on {date}) — within the {warnDays}-day warning',
  },
  'domain.noRegistrar':
    'this registry does not publish the registrar — the comparison could not be made',
  'domain.registrar':
    'registrar “{actual}”, “{expected}” expected — this is exactly what a domain transfer looks like',
  'domain.noNameservers': 'this registry does not publish the name servers',
  'domain.nameservers': 'no name server ends with “{suffix}” — current delegation: {nameservers}',
  'domain.noLock': 'the transfer lock is not announced{statuses}',
  'domain.noStatuses': ' (this registry publishes no status)',
  'domain.statuses': ' (statuses: {statuses})',
  'domain.noRdap':
    'the “.{tld}” TLD publishes no RDAP service — this probe cannot observe anything there, and a domain without RDAP is not a broken domain: better delete the probe',
  'domain.noRdapServer':
    'no known RDAP server for “.{tld}” — the IANA bootstrap list is unreachable and the TLD is not in the bundled bootstrap',
  'domain.registry': 'registry {server}: {detail}',
  'domain.unknown':
    'registry {server} does not know “{domain}” — domain expired and purged, or not the registered name (“example.com”, not “www.example.com”)',
  'domain.registryStatus':
    'registry {server} answered {status} — the registry is at fault, not the domain',
  'domain.unreadable': 'unreadable answer from registry {server} — this is not RDAP JSON',

  'inspect.rdapUnreadable': 'unreadable RDAP answer',
  'webhook.status': 'the receiver answered {status}',
};

export const probeCopy = { fr, en };

export type ProbeSay = Translate<typeof fr>;

export function probeSay(language: UiLanguage): ProbeSay {
  return translator(probeCopy, language);
}
