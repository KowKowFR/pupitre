import { translator, type Translate, type Translated, type UiLanguage } from '../../i18n.js';
import { proxyCopy } from '../messages.js';

/** What BunkerWeb says, in the instance's language. See `../messages.ts`. */
const fr = {
  ...proxyCopy.fr,

  'api.containerGone': 'le conteneur {container} est introuvable ou arrêté',
  'api.noToken':
    'le conteneur {container} n’a pas d’API_TOKEN : Pupitre ne peut pas piloter ce BunkerWeb',
  'api.failed': 'API de BunkerWeb, {what} : {detail}',
  'api.list': 'liste des services',
  'api.test': 'service d’essai',
  'api.create': 'création de {hostname}',
  'api.update': 'mise à jour de {hostname}',
  'api.remove': 'retrait de {hostname}',

  'detect.ports':
    'BunkerWeb ne reçoit pas les visiteurs sur les ports 80 et 443 de la machine ({http} et {https}) : les domaines ne lui parviendront pas',
  'detect.apiOff':
    'son API est désactivée : ajoutez SERVICE_API=yes et un API_TOKEN au conteneur, ou laissez Pupitre installer le sien',
  'detect.noToken':
    'son API n’a pas d’API_TOKEN ({name}) : Pupitre s’authentifie par jeton — ajoutez-en un au conteneur',
  'detect.noGateway': 'la passerelle Docker de la machine est introuvable',
  'detect.summary': 'BunkerWeb « {name} » ({image})',
  'detect.summary.api': ' — API : {name}',
  'detect.unusable': ' — inutilisable en l’état',

  'option.title': 'BunkerWeb en conteneur (WAF)',
  'option.noDocker':
    'BunkerWeb s’installe en conteneur Docker, absent de cette machine. Pour une machine K3s : reliez-la au BunkerWeb d’une machine Docker (« Ou passer par un autre reverse proxy »).',
  'option.noDisk': 'l’image de BunkerWeb pèse ~2,1 Go et il ne reste que {free} Go pour Docker',
  'option.lowMemory':
    ' — attention : {available} Mo de mémoire disponible, BunkerWeb en utilise ~650',
  'option.detail':
    'installer {image} (~2,1 Go, ~650 Mo de mémoire) sur les ports 80 et 443, API activée, interface web non{memory}',

  'install.acmeOnly': 'BunkerWeb n’accepte que Let’s Encrypt ou ZeroSSL comme autorité',
  'install.token': 'jeton de l’API : {detail}',
  'install.pulling': 'docker compose up — {image} (~2,1 Go à télécharger la première fois)',
  'install.apiDown': 'l’API de BunkerWeb ne répond pas : {detail}',
  'install.ready': 'BunkerWeb répond, son API aussi',
  'uninstall.removed': 'BunkerWeb retiré de la machine, données et certificats compris',

  'check.api': 'API de BunkerWeb',
  'check.api.ok': 'répond, jeton accepté',
  'check.apply': 'BunkerWeb applique ce qu’on lui confie',
  'check.apply.ok': 'un service d’essai y a été pris en compte, puis retiré',
  'check.apply.ignored': 'service d’essai ignoré ({code})',

  'apply.needsPort':
    'BunkerWeb joint une application par un port publié, pas par un Service du cluster : servez cette machine K3s par une liaison au BunkerWeb d’une machine Docker',
  'apply.foreign':
    '{hostnames} : déjà un service de BunkerWeb que Pupitre n’a pas créé — retirez-le de BunkerWeb ou choisissez un autre domaine',
  'apply.services': 'services BunkerWeb : {hostnames} → {upstream} (protection : {waf})',
  'apply.serviceRemoved': 'service BunkerWeb retiré : {hostname}',
  'apply.probeSecret': 'secret des sondes : {detail}',
  'apply.refused': 'BunkerWeb a refusé la configuration et garde la précédente : {detail}',
  'apply.notServed': 'BunkerWeb ne sert pas encore {hostnames} au bout de 40 s',
} as const;

const en: Translated<typeof fr> = {
  ...proxyCopy.en,

  'api.containerGone': 'container {container} is missing or stopped',
  'api.noToken': 'container {container} has no API_TOKEN: Pupitre cannot drive this BunkerWeb',
  'api.failed': 'BunkerWeb API, {what}: {detail}',
  'api.list': 'service list',
  'api.test': 'test service',
  'api.create': 'creating {hostname}',
  'api.update': 'updating {hostname}',
  'api.remove': 'removing {hostname}',

  'detect.ports':
    'BunkerWeb does not receive visitors on ports 80 and 443 of the machine ({http} and {https}): domains will not reach it',
  'detect.apiOff':
    'its API is disabled: add SERVICE_API=yes and an API_TOKEN to the container, or let Pupitre install its own',
  'detect.noToken':
    'its API has no API_TOKEN ({name}): Pupitre authenticates with a token — add one to the container',
  'detect.noGateway': 'the machine’s Docker gateway cannot be found',
  'detect.summary': 'BunkerWeb “{name}” ({image})',
  'detect.summary.api': ' — API: {name}',
  'detect.unusable': ' — unusable as is',

  'option.title': 'BunkerWeb in a container (WAF)',
  'option.noDocker':
    'BunkerWeb installs as a Docker container, and Docker is missing on this machine. For a K3s machine: link it to the BunkerWeb of a Docker machine (“Or go through another reverse proxy”).',
  'option.noDisk': 'the BunkerWeb image weighs ~2.1 GB and only {free} GB are left for Docker',
  'option.lowMemory': ' — warning: {available} MB of memory available, BunkerWeb uses ~650',
  'option.detail':
    'install {image} (~2.1 GB, ~650 MB of memory) on ports 80 and 443, API enabled, web interface off{memory}',

  'install.acmeOnly': 'BunkerWeb only accepts Let’s Encrypt or ZeroSSL as authority',
  'install.token': 'API token: {detail}',
  'install.pulling': 'docker compose up — {image} (~2.1 GB to download the first time)',
  'install.apiDown': 'the BunkerWeb API does not answer: {detail}',
  'install.ready': 'BunkerWeb answers, and so does its API',
  'uninstall.removed': 'BunkerWeb removed from the machine, data and certificates included',

  'check.api': 'BunkerWeb API',
  'check.api.ok': 'answers, token accepted',
  'check.apply': 'BunkerWeb applies what it is given',
  'check.apply.ok': 'a test service was picked up, then removed',
  'check.apply.ignored': 'test service ignored ({code})',

  'apply.needsPort':
    'BunkerWeb reaches an application through a published port, not a cluster Service: serve this K3s machine by linking it to the BunkerWeb of a Docker machine',
  'apply.foreign':
    '{hostnames}: already a BunkerWeb service that Pupitre did not create — remove it from BunkerWeb or choose another domain',
  'apply.services': 'BunkerWeb services: {hostnames} → {upstream} (protection: {waf})',
  'apply.serviceRemoved': 'BunkerWeb service removed: {hostname}',
  'apply.probeSecret': 'probe secret: {detail}',
  'apply.refused': 'BunkerWeb refused the configuration and keeps the previous one: {detail}',
  'apply.notServed': 'BunkerWeb still does not serve {hostnames} after 40 s',
};

export const bunkerwebCopy = { fr, en };

export type BunkerWebSay = Translate<typeof fr>;

export function bunkerwebSay(language: UiLanguage): BunkerWebSay {
  return translator(bunkerwebCopy, language);
}
