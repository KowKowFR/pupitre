import { translator, type Translate, type Translated, type UiLanguage } from '../i18n.js';

/**
 * Ce que disent les pièces communes aux drivers — exécution d'une commande,
 * pare-feu, rétention des versions, code source déposé —, dans la langue de
 * l'instance (`TargetContext.language`).
 *
 * Les lignes d'un journal de déploiement sont écrites au moment où elles sont
 * émises, comme les statuts de commit et les notifications : elles gardent la
 * langue qu'avait l'instance à ce moment-là.
 */
const fr = {
  'step.timeout': '« {step} » a dépassé son délai',
  'step.failed': 'Échec de « {step} » (code {code}) : {detail}',
  'step.noDetail': 'sans détail',
  'command.failed': 'Échec de « {command} » : {detail}',
  'preflight.disk': 'Espace disque',
  'preflight.disk.unreadable': 'sortie de df illisible',
  'preflight.disk.available': '{gib} Gio disponibles',
  'preflight.workdir': 'Répertoire de travail',
  'workdir.identity': 'impossible de résoudre l’identité du compte de déploiement',
  'workdir.sudoFailed': '{root} n’est pas écrivable et sudo a échoué',
  'workdir.provisioned': '{path} (provisionné via sudo)',
  'workdir.stillReadOnly': '{path} reste non écrivable après élévation',
  'port.allocatorMissing': 'allocatePort exige un `portAllocator` dans le contexte',
  'upload.workdirUnusable': 'Racine de déploiement inutilisable : {detail}',
  'upload.unknownReason': 'raison inconnue',
  'upload.deposited': '  déposé {path} ({bytes} octets)',

  'build.contextMissing.log': '✗ contexte de build absent pour « {service} » : {dockerfile}',
  'build.contextMissing':
    'Le service « {service} » se construit depuis {dockerfile}, mais le fichier est absent de {dir}. {hint}',
  'build.contextMissing.fromRepo': 'Le contexte est relatif à la racine du dépôt.',
  'build.contextMissing.additionalFiles':
    'Le contexte de build doit être fourni via `additionalFiles`.',
  'health.http': 'HTTP {status} sur {url}',
  'diagnose.noOutput': '(aucune sortie)',
  'images.removed': 'images des releases effacées retirées : {count}',
  'rollback.previousMissing': 'rollback exige un `previousDeployment` dans le contexte',
  'rollback.releaseGone': 'La version précédente {release} n’est plus sur la cible ({path})',
  'destroy.removing': '→ suppression de {path}',
  'destroy.done': '✓ déploiement détruit',
  'workload.inventoryFailed': 'Inventaire impossible : {detail}',
  'workload.update.managed':
    '« {name} » est déployée par le panel : sa mise à jour est un redéploiement, pas une recréation à la main. Passez par un nouveau déploiement.',

  'ufw.absent': '⚠ ufw absent de {target} — le port {port} n’est filtré par personne',
  'ufw.inactive': '⚠ ufw inactif sur {target} — aucune règle posée pour le port {port}',
  'ufw.ruleFailed': '⚠ ufw {rule} a échoué : {detail}',
  'ufw.nothingToRemove.absent': '⚠ ufw absent — aucune règle à retirer',
  'ufw.nothingToRemove.inactive': '⚠ ufw inactif — aucune règle à retirer',
  'ufw.stillThere': '⚠ la règle {port}/tcp ({comment}) est toujours présente : {rules}',
  'ufw.noRuleLeft': 'ufw : plus aucune règle {port}/tcp ({comment})',

  'retention.removed': {
    one: 'rétention : {count} version supprimée — {releases}',
    other: 'rétention : {count} versions supprimées — {releases}',
  },

  'source.depositing': 'dépôt du code source (archive du commit) dans {dir}/',
  'source.extractFailed.log': '✗ extraction du code source : {detail}',
  'source.extractFailed': 'Extraction du code source impossible : {detail}',
  'source.extracted': '✓ code source extrait',

  'secrets.unresolved':
    'Secret(s) déclaré(s) par l’AppSpec mais sans valeur résolue : {names}. Renseignez-les sur l’écran de l’application avant de déployer.',
} as const;

const en: Translated<typeof fr> = {
  'step.timeout': '“{step}” timed out',
  'step.failed': '“{step}” failed (code {code}): {detail}',
  'step.noDetail': 'no detail',
  'command.failed': '“{command}” failed: {detail}',
  'preflight.disk': 'Disk space',
  'preflight.disk.unreadable': 'unreadable df output',
  'preflight.disk.available': '{gib} GiB available',
  'preflight.workdir': 'Working directory',
  'workdir.identity': 'could not resolve the identity of the deployment account',
  'workdir.sudoFailed': '{root} is not writable and sudo failed',
  'workdir.provisioned': '{path} (provisioned with sudo)',
  'workdir.stillReadOnly': '{path} is still not writable after elevation',
  'port.allocatorMissing': 'allocatePort requires a `portAllocator` in the context',
  'upload.workdirUnusable': 'Unusable deployment root: {detail}',
  'upload.unknownReason': 'unknown reason',
  'upload.deposited': '  uploaded {path} ({bytes} bytes)',

  'build.contextMissing.log': '✗ build context missing for “{service}”: {dockerfile}',
  'build.contextMissing':
    'Service “{service}” builds from {dockerfile}, but the file is missing from {dir}. {hint}',
  'build.contextMissing.fromRepo': 'The context is relative to the repository root.',
  'build.contextMissing.additionalFiles':
    'The build context must be provided through `additionalFiles`.',
  'health.http': 'HTTP {status} on {url}',
  'diagnose.noOutput': '(no output)',
  'images.removed': 'images of removed releases deleted: {count}',
  'rollback.previousMissing': 'rollback requires a `previousDeployment` in the context',
  'rollback.releaseGone': 'Previous release {release} is no longer on the target ({path})',
  'destroy.removing': '→ deleting {path}',
  'destroy.done': '✓ deployment destroyed',
  'workload.inventoryFailed': 'Inventory failed: {detail}',
  'workload.update.managed':
    '“{name}” is deployed by the panel: updating it means redeploying, not recreating it by hand. Start a new deployment.',

  'ufw.absent': '⚠ ufw is not installed on {target} — nothing filters port {port}',
  'ufw.inactive': '⚠ ufw is inactive on {target} — no rule set for port {port}',
  'ufw.ruleFailed': '⚠ ufw {rule} failed: {detail}',
  'ufw.nothingToRemove.absent': '⚠ ufw is not installed — no rule to remove',
  'ufw.nothingToRemove.inactive': '⚠ ufw is inactive — no rule to remove',
  'ufw.stillThere': '⚠ the {port}/tcp rule ({comment}) is still there: {rules}',
  'ufw.noRuleLeft': 'ufw: no {port}/tcp rule left ({comment})',

  'retention.removed': {
    one: 'retention: {count} release removed — {releases}',
    other: 'retention: {count} releases removed — {releases}',
  },

  'source.depositing': 'uploading the source code (commit archive) to {dir}/',
  'source.extractFailed.log': '✗ extracting the source code: {detail}',
  'source.extractFailed': 'Could not extract the source code: {detail}',
  'source.extracted': '✓ source code extracted',

  'secrets.unresolved':
    'Secret(s) declared by the AppSpec but without a resolved value: {names}. Set them on the application screen before deploying.',
};

export const driverCopy = { fr, en };

export type DriverSay = Translate<typeof fr>;

export function driverSay(language: UiLanguage): DriverSay {
  return translator(driverCopy, language);
}
