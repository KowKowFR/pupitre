import { translator, type Translate, type Translated, type UiLanguage } from '../../i18n.js';
import { proxyCopy } from '../messages.js';

/** Ce que dit Nginx Proxy Manager, dans la langue de l'instance. Voir `../messages.ts`. */
const fr = {
  ...proxyCopy.fr,

  'api.unreachable': '{base} injoignable : {reason}',
  'login.refused': 'identifiants refusés par NPM pour {email} ({detail})',
  'login.twoFactor':
    'le compte {email} a la double authentification : Pupitre ne peut pas y répondre — donnez-lui un compte à lui, sans elle',
  'login.noToken': 'NPM n’a pas rendu de jeton',

  'check.api.detail': 'Nginx Proxy Manager{version} à {url}',
  'check.transport': 'Chiffrement',
  'check.transport.publicPlain':
    'HTTP sur une adresse publique : le mot de passe du compte passerait en clair — passez par HTTPS, ou par une adresse privée',
  'check.transport.privatePlain': 'HTTP, à réserver à un réseau privé',
  'check.login': 'Compte',
  'check.rights': 'Droits',
  'check.rights.admin': 'administrateur de NPM',
  'check.rights.manage': 'gère les hôtes et les certificats',
  'check.rights.own': 'gère les hôtes et les certificats — les siens seulement',
  'check.rights.missing':
    'le compte doit pouvoir gérer (« Manage ») les Proxy Hosts et les SSL Certificates',
  'check.entrypoint': 'Entrée',
  'check.entrypoint.both': 'reçoit sur {host}:{http} et {https}',
  'check.entrypoint.httpOnly': 'reçoit sur {host}:{http} — {https} fermé',
  'check.entrypoint.down':
    '{host}:{port} ne répond pas depuis le panel : les domaines ne pourront pas être sondés — réglez l’adresse où NPM reçoit les visiteurs',
  'check.summary': 'NPM {url} : {checks}',

  'apply.needsAddress':
    'Nginx Proxy Manager joint une application par une adresse et un port : reliez la machine à NPM',
  'apply.hostRemoved': 'NPM : {hostnames} retiré',
  'apply.foreign':
    '« {hostname} » existe déjà dans NPM, hors de Pupitre : retirez-le de NPM, ou choisissez un autre domaine',
  'apply.certificateRemoved': 'NPM : certificat {id} retiré',
  'apply.certificateKept': '⚠ certificat {id} non retiré : {error}',
  'apply.reuses': 'NPM : {hostname} reprend le certificat « {name} »',
  'apply.host': 'NPM : {hostname} → {upstream}',
  'apply.hostUpdated': 'NPM : {hostname} → {upstream} (mis à jour)',

  'certificate.requesting': 'NPM : demande d’un certificat pour {hostname}…',
  'certificate.obtained': 'NPM : certificat obtenu pour {hostname}',
  'certificate.failed':
    '⚠ NPM n’a pas obtenu de certificat pour {hostname} : {failure} — servi en HTTP ; le prochain déploiement ou l’enregistrement des domaines le redemandera',
  'probe.noCertificate':
    'HTTPS : NPM n’a pas encore de certificat pour ce domaine — le DNS doit pointer vers NPM et son port 80 être ouvert ; le prochain déploiement ou l’enregistrement des domaines le redemandera',

  'reach.relaying': 'NPM relaie {hostname} vers {address}:{port}',
  'reach.silent': 'NPM ne répond pas sur {host}:{port} depuis le panel',
} as const;

const en: Translated<typeof fr> = {
  ...proxyCopy.en,

  'api.unreachable': '{base} unreachable: {reason}',
  'login.refused': 'NPM refused the credentials of {email} ({detail})',
  'login.twoFactor':
    'account {email} has two-factor authentication: Pupitre cannot answer it — give it an account of its own, without it',
  'login.noToken': 'NPM returned no token',

  'check.api.detail': 'Nginx Proxy Manager{version} at {url}',
  'check.transport': 'Encryption',
  'check.transport.publicPlain':
    'HTTP on a public address: the account password would travel in clear text — use HTTPS, or a private address',
  'check.transport.privatePlain': 'HTTP, for a private network only',
  'check.login': 'Account',
  'check.rights': 'Permissions',
  'check.rights.admin': 'NPM administrator',
  'check.rights.manage': 'manages hosts and certificates',
  'check.rights.own': 'manages hosts and certificates — its own only',
  'check.rights.missing':
    'the account must be able to manage (“Manage”) Proxy Hosts and SSL Certificates',
  'check.entrypoint': 'Entry point',
  'check.entrypoint.both': 'receives on {host}:{http} and {https}',
  'check.entrypoint.httpOnly': 'receives on {host}:{http} — {https} closed',
  'check.entrypoint.down':
    '{host}:{port} does not answer from the panel: domains cannot be probed — set the address where NPM receives visitors',
  'check.summary': 'NPM {url}: {checks}',

  'apply.needsAddress':
    'Nginx Proxy Manager reaches an application by an address and a port: link the machine to NPM',
  'apply.hostRemoved': 'NPM: {hostnames} removed',
  'apply.foreign':
    '“{hostname}” already exists in NPM, outside Pupitre: remove it from NPM, or choose another domain',
  'apply.certificateRemoved': 'NPM: certificate {id} removed',
  'apply.certificateKept': '⚠ certificate {id} not removed: {error}',
  'apply.reuses': 'NPM: {hostname} reuses certificate “{name}”',
  'apply.host': 'NPM: {hostname} → {upstream}',
  'apply.hostUpdated': 'NPM: {hostname} → {upstream} (updated)',

  'certificate.requesting': 'NPM: requesting a certificate for {hostname}…',
  'certificate.obtained': 'NPM: certificate obtained for {hostname}',
  'certificate.failed':
    '⚠ NPM did not obtain a certificate for {hostname}: {failure} — served over HTTP; the next deployment or saving the domains will request it again',
  'probe.noCertificate':
    'HTTPS: NPM has no certificate for this domain yet — DNS must point to NPM and its port 80 must be open; the next deployment or saving the domains will request it again',

  'reach.relaying': 'NPM relays {hostname} to {address}:{port}',
  'reach.silent': 'NPM does not answer on {host}:{port} from the panel',
};

export const npmCopy = { fr, en };

export type NpmSay = Translate<typeof fr>;

export function npmSay(language: UiLanguage): NpmSay {
  return translator(npmCopy, language);
}
