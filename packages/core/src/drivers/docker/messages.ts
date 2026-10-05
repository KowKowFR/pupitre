import { translator, type Translate, type Translated, type UiLanguage } from '../../i18n.js';
import { driverCopy } from '../messages.js';

/**
 * What the Docker driver says — a deployment's log, preflight, errors —, in the
 * instance's language. The commands it quotes (`docker compose up`) are not
 * translated: they are those one would type on the machine.
 */
const fr = {
  ...driverCopy.fr,
  'preflight.daemon': 'Daemon Docker',

  'port.noProbe':
    '⚠ ni ss ni netstat sur la cible — impossible de vérifier les ports déjà en écoute',
  'port.reservedAfter': {
    one: 'port {port} réservé après {count} port écarté',
    other: 'port {port} réservé après {count} ports écartés',
  },
  'port.busy': '⚠ port {port} déjà en écoute sur {target} — réservation abandonnée',
  'port.exhausted':
    'Aucun port libre entre {min} et {max} sur « {target} » : {count} port(s) réservés en base se sont révélés occupés ({ports}).',

  'firewall.localOnly': 'port {port} publié sur {address} seulement — rien à ouvrir',

  'upload.release': 'projet {project}, release {release}',

  'deploy.unhealthy':
    'la nouvelle version a pris la place de l’ancienne sans devenir saine — {services}',
  'deploy.started': 'services démarrés',
  'deploy.startedAt': 'services démarrés — {url}',

  'health.noContainer': 'aucun conteneur en cours d’exécution',
  'health.noPort': 'aucun port publié — {running} conteneur(s), {bad} en défaut',
  'health.unreachable': '{url} injoignable depuis la cible (curl code {code}{detail})',

  'rollback.to': '→ retour à la release {release}',
  'rollback.done': '✓ revenu à la release {release}',

  'destroy.images': '→ retrait des images {images}',
  'destroy.closingPort': '→ fermeture du port {port} sur le pare-feu',
  'destroy.portReleased': '→ allocation de port libérée',

  'restart.done': 'services redémarrés',
  'stop.done': 'conteneurs arrêtés — volumes, réseau et réservation de port conservés',
  'start.recreating': '→ aucun conteneur à relancer : remontage depuis le compose.yml déposé',
  'start.recreated': 'services recréés et démarrés',
  'start.done': 'services démarrés',

  'workload.notFound': 'Aucun conteneur « {id} » sur cette cible',
  'workload.removing': '→ suppression du conteneur « {name} » ({id})',
  'workload.removed': '✓ conteneur supprimé — ses volumes nommés, eux, sont conservés',
  'workload.update.noImage': 'Impossible de lire l’image de « {name} »',
  'workload.update.unsupported':
    '« {name} » utilise des options que le panel ne sait pas reproduire ({options}). La recréer les perdrait : mettez-la à jour à la main.',
  'workload.update.execEntrypoint': '--entrypoint (forme exec)',
  'workload.update.upToDate': 'l’image était déjà à jour — la charge est tout de même recréée',
  'workload.update.updated': 'image mise à jour : {from} → {to}',
  'workload.update.setAside': '→ mise de côté de l’ancien conteneur sous « {backup} »',
  'workload.update.network': '→ rattachement au réseau {network}',
  'workload.update.restarted': '✓ conteneur recréé et redémarré',
  'workload.update.leftStopped': '✓ conteneur recréé, laissé à l’arrêt comme il l’était',
  'workload.update.rollingBack': '✗ recréation impossible — remise en place de l’ancien conteneur',
  'workload.update.oldRemoved': '✓ ancien conteneur retiré',
  'workload.control.invalid':
    '« {name} » est « {state} » : « {action} » n’a pas de sens dans cet état.',
  'workload.control.done': '✓ « {name} » : {action}',
  'workload.exec.notRunning':
    '« {name} » n’est pas en marche : une commande ne s’exécute que dans un conteneur démarré.',

  'backup.volumeMissing': 'Volume « {volume} » du service « {service} » introuvable sur la cible',
  'backup.serviceDown': 'Le service « {service} » ne tourne pas',
} as const;

const en: Translated<typeof fr> = {
  ...driverCopy.en,
  'preflight.daemon': 'Docker daemon',

  'port.noProbe':
    '⚠ neither ss nor netstat on the target — cannot check which ports are already listening',
  'port.reservedAfter': {
    one: 'port {port} reserved after skipping {count} port',
    other: 'port {port} reserved after skipping {count} ports',
  },
  'port.busy': '⚠ port {port} is already listening on {target} — reservation dropped',
  'port.exhausted':
    'No free port between {min} and {max} on “{target}”: {count} port(s) reserved in the database turned out to be in use ({ports}).',

  'firewall.localOnly': 'port {port} published on {address} only — nothing to open',

  'upload.release': 'project {project}, release {release}',

  'deploy.unhealthy': 'the new version replaced the old one without becoming healthy — {services}',
  'deploy.started': 'services started',
  'deploy.startedAt': 'services started — {url}',

  'health.noContainer': 'no running container',
  'health.noPort': 'no published port — {running} container(s), {bad} failing',
  'health.unreachable': '{url} unreachable from the target (curl code {code}{detail})',

  'rollback.to': '→ rolling back to release {release}',
  'rollback.done': '✓ back to release {release}',

  'destroy.images': '→ removing images {images}',
  'destroy.closingPort': '→ closing port {port} on the firewall',
  'destroy.portReleased': '→ port allocation released',

  'restart.done': 'services restarted',
  'stop.done': 'containers stopped — volumes, network and port reservation kept',
  'start.recreating':
    '→ no container to restart: bringing it back up from the uploaded compose.yml',
  'start.recreated': 'services recreated and started',
  'start.done': 'services started',

  'workload.notFound': 'No container “{id}” on this target',
  'workload.removing': '→ removing container “{name}” ({id})',
  'workload.removed': '✓ container removed — its named volumes are kept',
  'workload.update.noImage': 'Could not read the image of “{name}”',
  'workload.update.unsupported':
    '“{name}” uses options the panel cannot reproduce ({options}). Recreating it would lose them: update it by hand.',
  'workload.update.execEntrypoint': '--entrypoint (exec form)',
  'workload.update.upToDate': 'the image was already up to date — the workload is recreated anyway',
  'workload.update.updated': 'image updated: {from} → {to}',
  'workload.update.setAside': '→ setting the old container aside as “{backup}”',
  'workload.update.network': '→ attaching to network {network}',
  'workload.update.restarted': '✓ container recreated and restarted',
  'workload.update.leftStopped': '✓ container recreated, left stopped as it was',
  'workload.update.rollingBack': '✗ could not recreate it — putting the old container back',
  'workload.update.oldRemoved': '✓ old container removed',
  'workload.control.invalid': '“{name}” is “{state}”: “{action}” makes no sense in this state.',
  'workload.control.done': '✓ “{name}”: {action}',
  'workload.exec.notRunning':
    '“{name}” is not running: a command only runs in a started container.',

  'backup.volumeMissing': 'Volume “{volume}” of service “{service}” not found on the target',
  'backup.serviceDown': 'Service “{service}” is not running',
};

export const dockerCopy = { fr, en };

export function dockerSay(language: UiLanguage): Translate<typeof fr> {
  return translator(dockerCopy, language);
}
