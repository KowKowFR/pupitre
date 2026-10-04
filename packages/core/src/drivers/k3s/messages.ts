import { translator, type Translate, type Translated, type UiLanguage } from '../../i18n.js';
import { driverCopy } from '../messages.js';

/**
 * Ce que dit le driver K3s — journal d'un déploiement, preflight, erreurs,
 * état des charges —, dans la langue de l'instance. Les commandes qu'il cite
 * (`kubectl rollout status`) ne se traduisent pas : ce sont celles qu'on
 * taperait sur la machine.
 */
const fr = {
  ...driverCopy.fr,
  quoted: '« {name} »',

  'preflight.cluster': 'Cluster Kubernetes',
  'preflight.cluster.unreachable': 'kubectl injoignable (code {code})',
  'preflight.cluster.nodes': '{ready}/{total} node(s) prêt(s){version}',
  'preflight.ingress': 'Contrôleur d’ingress',
  'preflight.ingress.classes': 'IngressClass : {classes}',
  'preflight.ingress.none':
    'aucune IngressClass — sans reverse proxy, l’application ne sera joignable que dans le cluster',
  'preflight.canCreateNamespace': 'Droit de créer un namespace',
  'preflight.canCreateDeployment': 'Droit de créer un déploiement',
  'preflight.yes': 'oui',
  'preflight.no': 'non',
  'preflight.build': 'Construction d’images',
  'preflight.build.none': 'aucun service ne se construit depuis un Dockerfile',
  'preflight.build.namespaceRefused':
    '{names} à construire, et le namespace {namespace} du constructeur est refusé : {detail}',
  'preflight.build.accepted': '{names} — constructeur {image} accepté dans {namespace}',
  'preflight.build.refused':
    '{names} à construire, et le cluster refuse le constructeur ({image}, pod privilégié) : {detail}',

  'port.nodePortRange':
    'la plage de ports de la cible n’a rien en commun avec celle des NodePort ({min}-{max})',
  'port.nodePort': 'NodePort {port} : le proxy distant joindra l’application par là',

  'upload.release': 'namespace {namespace}, release {release}',
  'build.sendingContext': '→ envoi du contexte de « {service} » au constructeur',
  'builder.ensuring': '→ constructeur {name} ({image}) dans {namespace}',
  'builder.stays':
    '   il reste en place pour garder son cache, et sera retiré après {hours} h sans build',
  'builder.unreadable': 'Constructeur illisible : {detail}',
  'builder.removed': '✓ constructeur {name} retiré de {namespace} — dernier build le {date}',
  'builder.claimed': 'constructeur {name} réclamé par un build à l’instant : il reste',
  'builder.notRemoved': 'Constructeur non retiré : {detail}',
  'pull.failed': '   tirage impossible ({detail}) — l’image locale servira',
  'pull.stale': '« {service} » tourne sur une image antérieure — redémarrage sur {digest}…',

  'deploy.applied': 'déploiement appliqué',
  'deploy.appliedAt': 'déploiement appliqué — {url}',

  'health.noPod': 'aucun pod dans {namespace}',
  'health.podsReady': '{ready}/{total} pod(s) prêt(s)',
  'health.waiting': ' — en attente : {pods}',
  'health.unreachable': '{label} injoignable (code {code}{detail})',

  'rollback.noRevision':
    'Aucune révision antérieure pour {services} et aucun `previousDeployment` dans le contexte : rien vers quoi revenir.',
  'rollback.reapplying': '→ réapplication des manifests de la release {release}',
  'rollback.confirmed': '✓ rollback confirmé',

  'destroy.images': '→ retrait des images {namespace}/* de containerd',
  'destroy.nodePortReleased': '→ NodePort libéré',

  'restart.done': 'pods recréés',
  'stop.drained': 'pods retirés',
  'stop.draining': 'pod(s) en cours de terminaison',
  'stop.drainTimeout': 'des pods terminent encore après le délai imparti',
  'stop.done': 'répliques à zéro — PVC, Service et Ingress conservés',
  'start.done': 'pods prêts',

  'workload.system.remove':
    '« {name} » vit dans le namespace système « {namespace} » : le panel ne supprime pas ce qui fait tourner le cluster.',
  'workload.system.control':
    '« {name} » vit dans le namespace système « {namespace} » : le panel ne pilote pas ce qui fait tourner le cluster.',
  'workload.system.exec':
    '« {name} » vit dans le namespace système « {namespace} » : le panel n’y exécute rien.',
  'workload.removed': '✓ charge supprimée — les PVC du namespace sont conservés',
  'workload.update.pod':
    '« {name} » est un pod sans contrôleur : personne ne le recréerait après sa suppression. Le panel ne le met pas à jour.',
  'workload.update.done': '✓ pods recréés sur le manifeste courant',
  'workload.control.podRestart': '« {name} » est un pod sans contrôleur : rien ne le recréerait.',
  'workload.control.replaced': '✓ pods remplacés',
  'workload.control.daemonset':
    '« {name} » est un DaemonSet : il tourne sur chaque nœud et ne s’arrête pas sans être supprimé.',
  'workload.control.podStop':
    '« {name} » est un pod sans contrôleur : l’arrêter le supprimerait pour de bon.',
  'workload.control.alreadyStopped': 'déjà arrêtée — zéro réplique',
  'workload.control.scalingDown': '→ kubectl {ns} scale {path} --replicas=0 ({count} avant)',
  'workload.control.stopped': '✓ arrêtée — ses volumes et son service restent en place',
  'workload.control.alreadyRunning': 'déjà en marche — {count} réplique(s)',
  'workload.control.started': '✓ démarrée',
  'workload.logs.noSelector':
    '« {name} » n’a pas de sélecteur lisible : impossible de trouver ses pods.',
  'workload.exec.noReadyPod':
    '« {name} » n’a aucun pod prêt : une commande ne s’exécute que dans une charge en marche.',
  'workload.badRef': 'Référence de charge illisible : « {id} »',
  'workload.notFound': 'Aucune charge « {id} » sur cette cible : {detail}',
  'workload.unreadable': 'Charge « {id} » illisible',

  'since.ready': { one: '{ready}/{count} prêt', other: '{ready}/{count} prêts' },
  'since.scaledToZero': 'mis à l’échelle zéro',
  'since.restarts': { one: ' · {count} redémarrage', other: ' · {count} redémarrages' },
  'name.unknown': 'inconnu',
} as const;

const en: Translated<typeof fr> = {
  ...driverCopy.en,
  quoted: '“{name}”',

  'preflight.cluster': 'Kubernetes cluster',
  'preflight.cluster.unreachable': 'kubectl unreachable (code {code})',
  'preflight.cluster.nodes': '{ready}/{total} node(s) ready{version}',
  'preflight.ingress': 'Ingress controller',
  'preflight.ingress.classes': 'IngressClass: {classes}',
  'preflight.ingress.none':
    'no IngressClass — without a reverse proxy, the application will only be reachable inside the cluster',
  'preflight.canCreateNamespace': 'Permission to create a namespace',
  'preflight.canCreateDeployment': 'Permission to create a deployment',
  'preflight.yes': 'yes',
  'preflight.no': 'no',
  'preflight.build': 'Image builds',
  'preflight.build.none': 'no service builds from a Dockerfile',
  'preflight.build.namespaceRefused':
    '{names} to build, and the builder namespace {namespace} is refused: {detail}',
  'preflight.build.accepted': '{names} — builder {image} accepted in {namespace}',
  'preflight.build.refused':
    '{names} to build, and the cluster refuses the builder ({image}, privileged pod): {detail}',

  'port.nodePortRange':
    'the target’s port range has nothing in common with the NodePort range ({min}-{max})',
  'port.nodePort': 'NodePort {port}: the remote proxy will reach the application through it',

  'upload.release': 'namespace {namespace}, release {release}',
  'build.sendingContext': '→ sending the context of “{service}” to the builder',
  'builder.ensuring': '→ builder {name} ({image}) in {namespace}',
  'builder.stays':
    '   it stays in place to keep its cache, and will be removed after {hours} h without a build',
  'builder.unreadable': 'Builder unreadable: {detail}',
  'builder.removed': '✓ builder {name} removed from {namespace} — last build on {date}',
  'builder.claimed': 'builder {name} claimed by a build just now: it stays',
  'builder.notRemoved': 'Builder not removed: {detail}',
  'pull.failed': '   pull failed ({detail}) — the local image will be used',
  'pull.stale': '“{service}” runs an older image — restarting on {digest}…',

  'deploy.applied': 'deployment applied',
  'deploy.appliedAt': 'deployment applied — {url}',

  'health.noPod': 'no pod in {namespace}',
  'health.podsReady': '{ready}/{total} pod(s) ready',
  'health.waiting': ' — waiting: {pods}',
  'health.unreachable': '{label} unreachable (code {code}{detail})',

  'rollback.noRevision':
    'No earlier revision for {services} and no `previousDeployment` in the context: nothing to roll back to.',
  'rollback.reapplying': '→ reapplying the manifests of release {release}',
  'rollback.confirmed': '✓ rollback confirmed',

  'destroy.images': '→ removing images {namespace}/* from containerd',
  'destroy.nodePortReleased': '→ NodePort released',

  'restart.done': 'pods recreated',
  'stop.drained': 'pods removed',
  'stop.draining': 'pod(s) still terminating',
  'stop.drainTimeout': 'pods are still terminating after the allotted time',
  'stop.done': 'replicas at zero — PVCs, Service and Ingress kept',
  'start.done': 'pods ready',

  'workload.system.remove':
    '“{name}” lives in the system namespace “{namespace}”: the panel does not delete what runs the cluster.',
  'workload.system.control':
    '“{name}” lives in the system namespace “{namespace}”: the panel does not control what runs the cluster.',
  'workload.system.exec':
    '“{name}” lives in the system namespace “{namespace}”: the panel runs nothing there.',
  'workload.removed': '✓ workload removed — the namespace PVCs are kept',
  'workload.update.pod':
    '“{name}” is a pod without a controller: nothing would recreate it after its deletion. The panel does not update it.',
  'workload.update.done': '✓ pods recreated from the current manifest',
  'workload.control.podRestart':
    '“{name}” is a pod without a controller: nothing would recreate it.',
  'workload.control.replaced': '✓ pods replaced',
  'workload.control.daemonset':
    '“{name}” is a DaemonSet: it runs on every node and cannot be stopped without being deleted.',
  'workload.control.podStop':
    '“{name}” is a pod without a controller: stopping it would delete it for good.',
  'workload.control.alreadyStopped': 'already stopped — zero replicas',
  'workload.control.scalingDown': '→ kubectl {ns} scale {path} --replicas=0 ({count} before)',
  'workload.control.stopped': '✓ stopped — its volumes and its service stay in place',
  'workload.control.alreadyRunning': 'already running — {count} replica(s)',
  'workload.control.started': '✓ started',
  'workload.logs.noSelector': '“{name}” has no readable selector: cannot find its pods.',
  'workload.exec.noReadyPod':
    '“{name}” has no ready pod: a command only runs in a running workload.',
  'workload.badRef': 'Unreadable workload reference: “{id}”',
  'workload.notFound': 'No workload “{id}” on this target: {detail}',
  'workload.unreadable': 'Workload “{id}” is unreadable',

  'since.ready': { one: '{ready}/{count} ready', other: '{ready}/{count} ready' },
  'since.scaledToZero': 'scaled to zero',
  'since.restarts': { one: ' · {count} restart', other: ' · {count} restarts' },
  'name.unknown': 'unknown',
};

export const k3sCopy = { fr, en };

export type K3sSay = Translate<typeof fr>;

export function k3sSay(language: UiLanguage): K3sSay {
  return translator(k3sCopy, language);
}
