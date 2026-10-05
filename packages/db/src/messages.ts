import { translator, type Translate, type Translated, type UiLanguage } from '@pupitre/core';

/**
 * What this package writes for someone — a purge's refusal, the verdict given on
 * an abandoned deployment —, in the language the caller gives it (the
 * instance's). The abandonment verdict is written once, in the deployment's
 * error, and keeps the language it had that day — like the deployment's log.
 */
const fr = {
  'purge.identity': '{slug} v{version} sur {target}',
  'purge.inProgress':
    '{identity} est en cours d’exécution. Attendez qu’il se termine avant de le purger.',
  'purge.inService':
    '{identity} est la version en service sur cette cible : la purger ferait disparaître du panel une application qui tourne toujours. Détruisez-la d’abord.',
  'purge.onlyHandle':
    '{identity} a échoué après avoir démarré les services : des conteneurs peuvent tourner encore sur cette cible, et c’est la seule trace qui permette de les retrouver. Détruisez-le d’abord.',

  'abandon.stoppedAt': 'Le déploiement s’est arrêté à l’étape « {step} ».',
  'abandon.neverStarted': 'Le déploiement n’avait encore commencé aucune étape.',
  'abandon.stoppedNoStep': 'Le déploiement s’est arrêté sans qu’aucune étape ne soit en cours.',
  'abandon.pending':
    'Aucune étape n’ayant commencé, rien ne devrait avoir été déposé ni démarré sous « {workspace} » sur {where}. Le panel garde néanmoins la trace de ce déploiement tant qu’il n’est pas détruit ou purgé : c’est sa seule poignée si quelque chose avait malgré tout été fait.',
  'abandon.started':
    'À vérifier sur {where}, le panel ne peut pas le savoir d’ici : « {workspace} » peut porter des services démarrés, les fichiers déposés peuvent être en place{port}. Détruisez ce déploiement pour que le panel remette la cible à plat, ou allez constater sur la machine avant de purger.',
  'abandon.started.port': ', et le port {port} reste réservé à cette application',
  'abandon.beforeServices':
    'L’arrêt est survenu avant le démarrage des services : rien ne devrait tourner sous « {workspace} » sur {where}. Restent à vérifier les fichiers déposés sur la cible{port}. Détruisez ce déploiement pour que le panel les reprenne à son compte.',
  'abandon.beforeServices.port': ' et le port {port}, encore réservé à cette application',
  'abandon.message':
    '{opening} La tâche qui le portait n’existe plus dans aucun état exécutable de la file « ops » — {cause}, constaté le {stamp}. Plus rien ne la reprendra : le statut « en cours » était devenu faux, il est arrêté à « échoué ». {remains}',
} as const;

const en: Translated<typeof fr> = {
  'purge.identity': '{slug} v{version} on {target}',
  'purge.inProgress': '{identity} is running. Wait for it to finish before purging it.',
  'purge.inService':
    '{identity} is the version in service on this target: purging it would remove from the panel an application that is still running. Destroy it first.',
  'purge.onlyHandle':
    '{identity} failed after starting its services: containers may still be running on this target, and this is the only trace that can find them. Destroy it first.',

  'abandon.stoppedAt': 'The deployment stopped at step “{step}”.',
  'abandon.neverStarted': 'The deployment had not started any step yet.',
  'abandon.stoppedNoStep': 'The deployment stopped with no step in progress.',
  'abandon.pending':
    'Since no step had started, nothing should have been uploaded or started under “{workspace}” on {where}. The panel still keeps this deployment until it is destroyed or purged: it is its only handle if something was done after all.',
  'abandon.started':
    'To check on {where}, the panel cannot know from here: “{workspace}” may carry started services, and the uploaded files may be in place{port}. Destroy this deployment so the panel cleans up the target, or go and look on the machine before purging.',
  'abandon.started.port': ', and port {port} is still reserved for this application',
  'abandon.beforeServices':
    'It stopped before the services started: nothing should be running under “{workspace}” on {where}. The files uploaded to the target remain to be checked{port}. Destroy this deployment so the panel takes them back.',
  'abandon.beforeServices.port': ', as does port {port}, still reserved for this application',
  'abandon.message':
    '{opening} The job that carried it no longer exists in any runnable state of the “ops” queue — {cause}, observed on {stamp}. Nothing will pick it up again: the “running” status had become false, so it is stopped as “failed”. {remains}',
};

export const dbCopy = { fr, en };

export type DbSay = Translate<typeof fr>;

export function dbSay(language: UiLanguage): DbSay {
  return translator(dbCopy, language);
}
