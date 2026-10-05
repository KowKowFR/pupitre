import { translator, type Translate, type Translated, type UiLanguage } from '@pupitre/core';

/**
 * Ce que le worker écrit pour quelqu'un, dans la langue de l'instance
 * (`instanceLanguage()`) : le journal et les erreurs d'un déploiement, le
 * compte rendu d'une suppression en cascade, le fil d'un arrêt ou d'un
 * redémarrage. Les journaux du worker lui-même (`logger.*`) ne sont pas ici :
 * ils sont pour qui l'exploite, pas pour qui se sert du panel.
 */
const fr = {
  'notFound.deployment': 'Déploiement « {id} » introuvable',
  'notFound.target': 'Cible « {id} » introuvable',
  'rollback.noPrevious': 'aucun déploiement précédent vers lequel revenir',
  'lifecycle.notRestartable': 'Un déploiement « {status} » ne se redémarre pas',
  'lifecycle.refused.stop': 'Un déploiement « {status} » ne s’arrête pas',
  'lifecycle.refused.start': 'Un déploiement « {status} » ne se démarre pas',

  'pipeline.resume': {
    one: 'Reprise : {count} étape déjà réussie ne sera pas rejouée.',
    other: 'Reprise : {count} étapes déjà réussies ne seront pas rejouées.',
  },
  'pipeline.portRangesDisjoint':
    '⚠ la plage de la cible ({targetMin}-{targetMax}) et celle du worker ({workerMin}-{workerMax}) ne se recouvrent pas — la plage de la cible est retenue',
  'pipeline.preflightRefused': 'la cible ne peut pas accueillir ce déploiement',
  'pipeline.port.notByPort': 'le runtime n’expose pas par port — étape sans objet',
  'pipeline.port.reserved': 'port {port} réservé dans {min}-{max}',
  'pipeline.firewall.none': 'ce runtime ne gère pas de pare-feu — rien à ouvrir',
  'pipeline.render.file': '{path} — {bytes} octets',
  'pipeline.upload.nothing': 'rien à déposer : le rendu a échoué',
  'pipeline.build.none': 'aucune image à construire — étape sans objet',
  'pipeline.scan.disabled':
    'analyse de sécurité désactivée dans les paramètres de l’instance — étape sans objet',
  'pipeline.scan.none': 'aucun scanner sélectionné — étape sans objet',
  'pipeline.scan.summary': '{runs} exécution(s), {findings} finding(s) — {verdicts}',
  'pipeline.scan.verdict': '{scanner} : {verdict}',
  'pipeline.scan.blocked':
    '{count} vulnérabilité(s) au niveau {failOn} ou au-dessus — déploiement bloqué : {worst}',
  'pipeline.backup.notRequested': 'sauvegarde avant déploiement non demandée — étape sans objet',
  'pipeline.backup.firstDeploy': 'premier déploiement sur cette cible : rien à sauvegarder encore',
  'pipeline.backup.failed': 'sauvegarde préalable impossible — déploiement interrompu : {error}',
  'pipeline.backup.skipped': '{reason} — étape sans objet',
  'pipeline.health.ok': {
    one: 'sain après {count} tentative — {detail}',
    other: 'sain après {count} tentatives — {detail}',
  },
  'pipeline.health.failed': {
    one: '{outcome} après {count} tentative — {detail}',
    other: '{outcome} après {count} tentatives — {detail}',
  },
  'pipeline.health.summary': '{outcome} : {detail}',
  'pipeline.health.noAnswer': 'le service ne répond pas',
  'pipeline.rollback.notNeeded': 'le déploiement est sain — aucun retour arrière',
  'pipeline.rollback.auto':
    'la version {from} (déploiement #{fromSequence}) n’est pas saine — retour automatique à la version {to} (déploiement #{toSequence})',
  'pipeline.rollback.healthy': {
    one: 'version {version} saine après {count} tentative — {detail}',
    other: 'version {version} saine après {count} tentatives — {detail}',
  },
  'pipeline.rollback.restoredDown': 'la version restaurée ne répond pas : {detail}',
  'pipeline.rollback.restoredButDown':
    'la version {version} a été restaurée mais ne répond pas : {detail}',
  'pipeline.rollback.failed': '{failure} — le rollback automatique a échoué : {error}',
  'pipeline.healthcheckFailed': 'version malsaine',
  'pipeline.step.alreadyDone': 'déjà réussie',
  'pipeline.step.notReached': 'étape non atteinte',
  'pipeline.port.kept': 'port {port} conservé : une version tourne encore sur la cible',
  'pipeline.port.released': 'port {port} libéré : le déploiement n’a rien laissé derrière lui',
  version: 'version {version}',
  noDetail: 'sans détail',

  'outcome.healthy': 'sain',
  'outcome.unhealthy': 'répond mais en erreur',
  'outcome.unreachable': 'injoignable',

  'scan.cleared': {
    one: '{count} exécution précédente écartée',
    other: '{count} exécutions précédentes écartées',
  },
  'scan.plan': '{scanners} sur {images} image(s) — seuil de blocage : {failOn}{options}',
  'scan.plan.onlyFixable': ', failles corrigeables seulement',
  'scan.plan.accepted': ', {count} faille(s) acceptée(s)',
  'scan.unrecorded': '[{scanner}] exécution non enregistrée : {error}',
  'scan.installFailed': '{prefix} installation impossible : {error}',
  'scan.sbom': 'SBOM produit',
  'scan.findings': '{count} finding(s)',
  'scan.worst': ' — pire sévérité : {severity}',
  'scan.vulnerabilities': ' — {fixable} corrigeable(s){accepted}, {blocking} bloquante(s)',
  'scan.accepted': ', {count} acceptée(s)',
  'scan.verdict': ' — verdict {verdict} ({ms} ms)',

  'source.archiveGone':
    'l’archive « {name} » de ce déploiement n’est plus conservée — Pupitre garde les {kept} dernières de chaque application : téléversez-la de nouveau',
  'source.archiveRead': 'archive « {name} » (sha256 {sha}…) relue depuis le panel — {size} Mio',
  'source.linkGone':
    'la liaison au dépôt {repository} a été supprimée : impossible de récupérer le code du commit à construire',
  'source.connectionGone':
    'la connexion au fournisseur de {repository} a été retirée : impossible de récupérer le code du commit',
  'source.downloading': 'téléchargement de {repository}@{sha}',
  'source.received': 'archive reçue ({size} Mio)',

  'rollback.manual.healthy': 'version {version} saine — {detail}',
  'rollback.manual.down': '⚠ la version restaurée ne répond pas : {detail}',

  'lifecycle.started': 'démarré',
  'lifecycle.done': 'terminé',
  'lifecycle.healthy': 'terminé, service sain',
  'lifecycle.unhealthy': 'terminé, service en défaut',
  'lifecycle.outcome': 'terminé, {outcome}',

  'cascade.notFound': 'Application « {id} » introuvable',
  'cascade.alreadyErased': 'Application « {id} » déjà effacée',
  'cascade.inProgress':
    '{count} déploiement(s) de « {slug} » sont en cours. Attendez qu’ils se terminent : {list}.',
  'cascade.identity': '{slug} v{version} sur {target}',
  'cascade.partial':
    '{destroyed} déploiement(s) détruit(s), {abandoned} impossible(s) à détruire : {residues}. « {slug} » et son historique sont intacts.',
  'cascade.historyStuck': 'Historique impurgeable après destruction : {refusals}',
  'cascade.deleted':
    '« {slug} » supprimée : {destroyed} déploiement(s) détruit(s) sur leur cible, {purged} effacé(s) de l’historique, {ports}.',
  'cascade.forced':
    '« {slug} » effacée de force : {destroyed} déploiement(s) détruit(s), {abandoned} abandonné(s) sur leur machine — {residues}. {ports}.',
  'cascade.residue': '{workspace} sur {target} ({host}, {port}) — {error}',
  'cascade.noPort': 'sans port publié',
  'cascade.port': 'port {port}',
  'cascade.noPortToRelease': 'aucun port à rendre',
  'cascade.portsReleased': 'port(s) rendu(s) : {ports}',
  'cascade.portOn': '{port} sur {target}',

  'abandoned.cause': 'BullMQ a terminé la tâche « {job} » en échec sans l’exécuter : « {reason} »',
  'abandoned.detectedBy': 'tâche « {job} » terminée en échec sans avoir été exécutée',

  'proxy.none': 'aucun reverse proxy ne sert cette cible — application jointe par son port',
  'proxy.noneWithRoutes': {
    one: 'aucun reverse proxy ne sert cette cible : {hostnames} non routé',
    other: 'aucun reverse proxy ne sert cette cible : {hostnames} non routés',
  },
  'proxy.installing':
    'le reverse proxy est en cours d’installation — domaines posés au prochain déploiement',
  'proxy.servedBy': 'servie par le proxy « {proxy} », qui la joint à {address}',
  'proxy.noDomain': 'aucun domaine pour cette application',
  'proxy.certificatePending': ' — certificat en cours d’émission',
  'proxy.certificateValid': ' — certificat valide jusqu’au {date}',
  'proxy.problem': '{hostname} : {detail}',
  'proxy.notRemoved': '⚠ routes non retirées du proxy : {error}',
  'proxy.released': { one: '{count} domaine libéré', other: '{count} domaines libérés' },
  'proxy.notRunning': 'l’application ne tourne pas sur cette cible',
  'proxy.failedCheck': '{label} : {detail}',
  'proxy.failed': 'en échec',
  'proxy.stillServing': 'des domaines passent encore par ce proxy : retirez-les d’abord',
  'proxy.notFound': 'connexion de proxy introuvable',
  'proxy.noHost': 'ce proxy ne tourne sur aucune machine connue',
  'link.gone': 'le proxy de cette liaison a disparu',
  'link.none': 'aucune liaison pour cette cible',
  'link.unreachable':
    'le proxy de « {proxy} » ne joint pas cette machine : {detail}. Rétablissez le passage de « {proxy} » vers {address} (ports {min}-{max}), puis « Tester la liaison » dans l’onglet Reverse proxy de la cible.',
  'link.ok': '✓ liaison au proxy de « {proxy} » : {detail}',
  'link.from': ' — arrivée depuis {source}',

  'source.missingFile': '{path} absent à ce commit',
  'source.rejected': '{path} refusé au commit {sha} : {issues}',
  'source.rejectedPrefix': '{path} refusé',
  'source.connectionRemoved': 'la connexion au fournisseur de ce dépôt a été retirée',
  'sourceDeploy.targetGone': 'cible supprimée',
  'sourceDeploy.neverTested': 'jamais testée : lancez un preflight',
  'sourceDeploy.runtimeUnavailable': '{runtime} indisponible sur cette cible',

  'backup.dbNotReady': 'la base « {service} » ne répond pas : {error}',
  'backup.notRestorable': "cette sauvegarde n'est pas restaurable",
  'backup.appDeleted': "l'application de cette sauvegarde a été supprimée",
  'backup.notRunning': "l'application ne tourne pas sur cette cible",
  'backup.stopped': "l'application est arrêtée : démarrez-la avant de restaurer",
  'backup.pieceGone': "⚠ « {piece} » n'existe plus dans l'AppSpec en service — morceau ignoré",
  'backup.pieceFetched': '✓ {file} téléchargé et vérifié',
  'backup.safety': "sauvegarde de sûreté de l'état actuel",
  'backup.safetyFailed': 'sauvegarde de sûreté impossible — restauration annulée : {error}',
  'backup.stoppingForVolumes': "arrêt de l'application pour remplacer ses volumes",
  'backup.volumeRestored': '✓ volume « {volume} » de « {service} » restauré',
  'backup.restarting': "redémarrage de l'application",
  'backup.databaseRestored': '✓ base « {service} » ({engine}) restaurée',
  'backup.restartingToReconnect': "redémarrage de l'application, pour qu'elle se reconnecte",
  'backup.appGone': 'application supprimée',
  'backup.nothing': 'rien à sauvegarder : aucun volume déclaré',
  'backup.alreadyRunning': 'une sauvegarde de cette application est déjà en cours',
  'backup.starting': {
    one: 'sauvegarde de « {slug} » vers {destination} — {count} morceau, mode {mode}',
    other: 'sauvegarde de « {slug} » vers {destination} — {count} morceaux, mode {mode}',
  },
  'backup.mode.hot': 'à chaud',
  'backup.mode.stop': 'arrêt bref',
  'backup.briefStop': "arrêt bref de l'application",
  'backup.volumeLabel': 'volume « {volume} » de « {service} »',
  'backup.dumpLabel': 'export {engine} de « {service} »',
  'backup.pieceStored': '✓ {label} — {size} en {seconds} s',
  'backup.done': 'sauvegarde terminée — {size} au total',
  'backup.destinationGone': 'la destination de cette sauvegarde a été supprimée',
  'backup.noDestination': 'aucune destination de sauvegarde configurée — Paramètres › Sauvegardes',
  'backup.changed': '« {key} » a changé depuis la sauvegarde (empreinte {hash}…)',
  'backup.retentionFailed': 'rétention : « {location} » non effacée — {error}',
  'backup.retentionDone': {
    one: 'rétention : {count} sauvegarde ancienne effacée',
    other: 'rétention : {count} sauvegardes anciennes effacées',
  },
  'backup.panelRunning': 'une sauvegarde du panel est déjà en cours',
  'backup.commandMissing':
    "« {command} » introuvable — l'image du worker l'embarque ; hors Docker, installez le client PostgreSQL",
  'backup.commandFailed': '{command} a échoué (code {code}) : {detail}',
  'backup.alreadyDeleted': 'déjà effacée',
  'backup.interrupted': 'interrompue : le worker a redémarré pendant la sauvegarde',

  'mail.noSmtp': 'aucun canal SMTP actif sur cette instance',
  'schedule.truncated': '… journal tronqué',
  'schedule.deleted': 'tâche supprimée',
  'schedule.disabled': 'tâche désactivée',
  'schedule.stoppedNotProbed': 'arrêtée volontairement, non sondée',
  'schedule.scanAlert':
    "⚠ {id} : {count} finding(s) au seuil {failOn} — aucune action automatique, ce scan n'interrompt rien",
  'schedule.preflightQueued': 'preflight enfilé pour {target} (job {job})',
  'schedule.noAutoBackup': "aucune application n'a la sauvegarde automatique activée",
  'schedule.backupQueued': 'sauvegarde enfilée : {slug}',
  'schedule.panelBackupQueued': 'sauvegarde de la base du panel enfilée (job {job})',
  'bytes.unit': 'o',
  'bytes.units': 'Kio,Mio,Gio,Tio',
} as const;

const en: Translated<typeof fr> = {
  'notFound.deployment': 'Deployment “{id}” not found',
  'notFound.target': 'Target “{id}” not found',
  'rollback.noPrevious': 'no previous deployment to roll back to',
  'lifecycle.notRestartable': 'A “{status}” deployment cannot be restarted',
  'lifecycle.refused.stop': 'A “{status}” deployment cannot be stopped',
  'lifecycle.refused.start': 'A “{status}” deployment cannot be started',

  'pipeline.resume': {
    one: 'Resuming: {count} step that already succeeded will not be replayed.',
    other: 'Resuming: {count} steps that already succeeded will not be replayed.',
  },
  'pipeline.portRangesDisjoint':
    '⚠ the target range ({targetMin}-{targetMax}) and the worker range ({workerMin}-{workerMax}) do not overlap — the target range is used',
  'pipeline.preflightRefused': 'the target cannot host this deployment',
  'pipeline.port.notByPort': 'the runtime does not expose through a port — step not applicable',
  'pipeline.port.reserved': 'port {port} reserved in {min}-{max}',
  'pipeline.firewall.none': 'this runtime does not manage a firewall — nothing to open',
  'pipeline.render.file': '{path} — {bytes} bytes',
  'pipeline.upload.nothing': 'nothing to upload: rendering failed',
  'pipeline.build.none': 'no image to build — step not applicable',
  'pipeline.scan.disabled':
    'security scanning is disabled in the instance settings — step not applicable',
  'pipeline.scan.none': 'no scanner selected — step not applicable',
  'pipeline.scan.summary': '{runs} run(s), {findings} finding(s) — {verdicts}',
  'pipeline.scan.verdict': '{scanner}: {verdict}',
  'pipeline.scan.blocked':
    '{count} vulnerability(ies) at {failOn} or above — deployment blocked: {worst}',
  'pipeline.backup.notRequested': 'no backup requested before deploying — step not applicable',
  'pipeline.backup.firstDeploy': 'first deployment on this target: nothing to back up yet',
  'pipeline.backup.failed': 'the pre-deployment backup failed — deployment stopped: {error}',
  'pipeline.backup.skipped': '{reason} — step not applicable',
  'pipeline.health.ok': {
    one: 'healthy after {count} attempt — {detail}',
    other: 'healthy after {count} attempts — {detail}',
  },
  'pipeline.health.failed': {
    one: '{outcome} after {count} attempt — {detail}',
    other: '{outcome} after {count} attempts — {detail}',
  },
  'pipeline.health.summary': '{outcome}: {detail}',
  'pipeline.health.noAnswer': 'the service does not respond',
  'pipeline.rollback.notNeeded': 'the deployment is healthy — no rollback',
  'pipeline.rollback.auto':
    'version {from} (deployment #{fromSequence}) is not healthy — rolling back automatically to version {to} (deployment #{toSequence})',
  'pipeline.rollback.healthy': {
    one: 'version {version} healthy after {count} attempt — {detail}',
    other: 'version {version} healthy after {count} attempts — {detail}',
  },
  'pipeline.rollback.restoredDown': 'the restored version does not respond: {detail}',
  'pipeline.rollback.restoredButDown':
    'version {version} was restored but does not respond: {detail}',
  'pipeline.rollback.failed': '{failure} — the automatic rollback failed: {error}',
  'pipeline.healthcheckFailed': 'unhealthy version',
  'pipeline.step.alreadyDone': 'already succeeded',
  'pipeline.step.notReached': 'step not reached',
  'pipeline.port.kept': 'port {port} kept: a version is still running on the target',
  'pipeline.port.released': 'port {port} released: the deployment left nothing behind',
  version: 'version {version}',
  noDetail: 'no detail',

  'outcome.healthy': 'healthy',
  'outcome.unhealthy': 'responds with an error',
  'outcome.unreachable': 'unreachable',

  'scan.cleared': {
    one: '{count} previous run discarded',
    other: '{count} previous runs discarded',
  },
  'scan.plan': '{scanners} on {images} image(s) — blocking threshold: {failOn}{options}',
  'scan.plan.onlyFixable': ', fixable vulnerabilities only',
  'scan.plan.accepted': ', {count} accepted vulnerability(ies)',
  'scan.unrecorded': '[{scanner}] run not recorded: {error}',
  'scan.installFailed': '{prefix} installation failed: {error}',
  'scan.sbom': 'SBOM produced',
  'scan.findings': '{count} finding(s)',
  'scan.worst': ' — worst severity: {severity}',
  'scan.vulnerabilities': ' — {fixable} fixable{accepted}, {blocking} blocking',
  'scan.accepted': ', {count} accepted',
  'scan.verdict': ' — verdict {verdict} ({ms} ms)',

  'source.archiveGone':
    'the archive “{name}” of this deployment is no longer kept — Pupitre keeps the last {kept} of each application: upload it again',
  'source.archiveRead': 'archive “{name}” (sha256 {sha}…) read back from the panel — {size} MiB',
  'source.linkGone':
    'the link to repository {repository} was deleted: cannot fetch the code of the commit to build',
  'source.connectionGone':
    'the connection to the provider of {repository} was removed: cannot fetch the code of the commit',
  'source.downloading': 'downloading {repository}@{sha}',
  'source.received': 'archive received ({size} MiB)',

  'rollback.manual.healthy': 'version {version} healthy — {detail}',
  'rollback.manual.down': '⚠ the restored version does not respond: {detail}',

  'lifecycle.started': 'started',
  'lifecycle.done': 'done',
  'lifecycle.healthy': 'done, service healthy',
  'lifecycle.unhealthy': 'done, service failing',
  'lifecycle.outcome': 'done, {outcome}',

  'cascade.notFound': 'Application “{id}” not found',
  'cascade.alreadyErased': 'Application “{id}” already erased',
  'cascade.inProgress':
    '{count} deployment(s) of “{slug}” are running. Wait for them to finish: {list}.',
  'cascade.identity': '{slug} v{version} on {target}',
  'cascade.partial':
    '{destroyed} deployment(s) destroyed, {abandoned} could not be destroyed: {residues}. “{slug}” and its history are intact.',
  'cascade.historyStuck': 'History cannot be purged after destruction: {refusals}',
  'cascade.deleted':
    '“{slug}” deleted: {destroyed} deployment(s) destroyed on their target, {purged} erased from history, {ports}.',
  'cascade.forced':
    '“{slug}” force-deleted: {destroyed} deployment(s) destroyed, {abandoned} left behind on their machine — {residues}. {ports}.',
  'cascade.residue': '{workspace} on {target} ({host}, {port}) — {error}',
  'cascade.noPort': 'no published port',
  'cascade.port': 'port {port}',
  'cascade.noPortToRelease': 'no port to release',
  'cascade.portsReleased': 'port(s) released: {ports}',
  'cascade.portOn': '{port} on {target}',

  'abandoned.cause': 'BullMQ marked job “{job}” as failed without running it: “{reason}”',
  'abandoned.detectedBy': 'job “{job}” marked as failed without having run',

  'proxy.none': 'no reverse proxy serves this target — the application is reached by its port',
  'proxy.noneWithRoutes': {
    one: 'no reverse proxy serves this target: {hostnames} not routed',
    other: 'no reverse proxy serves this target: {hostnames} not routed',
  },
  'proxy.installing':
    'the reverse proxy is being installed — domains will be set at the next deployment',
  'proxy.servedBy': 'served by proxy “{proxy}”, which reaches it at {address}',
  'proxy.noDomain': 'no domain for this application',
  'proxy.certificatePending': ' — certificate being issued',
  'proxy.certificateValid': ' — certificate valid until {date}',
  'proxy.problem': '{hostname}: {detail}',
  'proxy.notRemoved': '⚠ routes not removed from the proxy: {error}',
  'proxy.released': { one: '{count} domain released', other: '{count} domains released' },
  'proxy.notRunning': 'the application does not run on this target',
  'proxy.failedCheck': '{label}: {detail}',
  'proxy.failed': 'failed',
  'proxy.stillServing': 'domains still go through this proxy: remove them first',
  'proxy.notFound': 'proxy connection not found',
  'proxy.noHost': 'this proxy runs on no known machine',
  'link.gone': 'the proxy of this link has disappeared',
  'link.none': 'no link for this target',
  'link.unreachable':
    'the proxy of “{proxy}” cannot reach this machine: {detail}. Restore the path from “{proxy}” to {address} (ports {min}-{max}), then “Test the link” in the target’s Reverse proxy tab.',
  'link.ok': '✓ link to the proxy of “{proxy}”: {detail}',
  'link.from': ' — arriving from {source}',

  'source.missingFile': '{path} missing at this commit',
  'source.rejected': '{path} rejected at commit {sha}: {issues}',
  'source.rejectedPrefix': '{path} rejected',
  'source.connectionRemoved': 'the connection to this repository’s provider was removed',
  'sourceDeploy.targetGone': 'target deleted',
  'sourceDeploy.neverTested': 'never tested: run a preflight',
  'sourceDeploy.runtimeUnavailable': '{runtime} unavailable on this target',

  'backup.dbNotReady': 'database “{service}” does not answer: {error}',
  'backup.notRestorable': 'this backup cannot be restored',
  'backup.appDeleted': 'the application of this backup was deleted',
  'backup.notRunning': 'the application does not run on this target',
  'backup.stopped': 'the application is stopped: start it before restoring',
  'backup.pieceGone': '⚠ “{piece}” no longer exists in the AppSpec in service — piece skipped',
  'backup.pieceFetched': '✓ {file} downloaded and verified',
  'backup.safety': 'safety backup of the current state',
  'backup.safetyFailed': 'safety backup failed — restore cancelled: {error}',
  'backup.stoppingForVolumes': 'stopping the application to replace its volumes',
  'backup.volumeRestored': '✓ volume “{volume}” of “{service}” restored',
  'backup.restarting': 'restarting the application',
  'backup.databaseRestored': '✓ database “{service}” ({engine}) restored',
  'backup.restartingToReconnect': 'restarting the application so it reconnects',
  'backup.appGone': 'application deleted',
  'backup.nothing': 'nothing to back up: no volume declared',
  'backup.alreadyRunning': 'a backup of this application is already running',
  'backup.starting': {
    one: 'backing up “{slug}” to {destination} — {count} piece, mode {mode}',
    other: 'backing up “{slug}” to {destination} — {count} pieces, mode {mode}',
  },
  'backup.mode.hot': 'hot',
  'backup.mode.stop': 'brief stop',
  'backup.briefStop': 'stopping the application briefly',
  'backup.volumeLabel': 'volume “{volume}” of “{service}”',
  'backup.dumpLabel': '{engine} export of “{service}”',
  'backup.pieceStored': '✓ {label} — {size} in {seconds} s',
  'backup.done': 'backup done — {size} in total',
  'backup.destinationGone': 'the destination of this backup was deleted',
  'backup.noDestination': 'no backup destination configured — Settings › Backups',
  'backup.changed': '“{key}” changed since the backup (fingerprint {hash}…)',
  'backup.retentionFailed': 'retention: “{location}” not deleted — {error}',
  'backup.retentionDone': {
    one: 'retention: {count} old backup deleted',
    other: 'retention: {count} old backups deleted',
  },
  'backup.panelRunning': 'a panel backup is already running',
  'backup.commandMissing':
    '“{command}” not found — the worker image ships it; outside Docker, install the PostgreSQL client',
  'backup.commandFailed': '{command} failed (code {code}): {detail}',
  'backup.alreadyDeleted': 'already deleted',
  'backup.interrupted': 'interrupted: the worker restarted during the backup',

  'mail.noSmtp': 'no active SMTP channel on this instance',
  'schedule.truncated': '… log truncated',
  'schedule.deleted': 'task deleted',
  'schedule.disabled': 'task disabled',
  'schedule.stoppedNotProbed': 'stopped on purpose, not probed',
  'schedule.scanAlert':
    '⚠ {id}: {count} finding(s) at threshold {failOn} — no automatic action, this scan interrupts nothing',
  'schedule.preflightQueued': 'preflight queued for {target} (job {job})',
  'schedule.noAutoBackup': 'no application has automatic backup enabled',
  'schedule.backupQueued': 'backup queued: {slug}',
  'schedule.panelBackupQueued': 'panel database backup queued (job {job})',
  'bytes.unit': 'B',
  'bytes.units': 'KiB,MiB,GiB,TiB',
};

export const workerCopy = { fr, en };

export type WorkerSay = Translate<typeof fr>;

export function workerSay(language: UiLanguage): WorkerSay {
  return translator(workerCopy, language);
}

/** Une taille lisible, dans les unités de la langue : « 1,4 Mio », « 1.4 MiB ». */
export function formatBytes(bytes: number, language: UiLanguage): string {
  const say = workerSay(language);
  if (bytes < 1024) return `${bytes} ${say('bytes.unit')}`;
  const units = say('bytes.units').split(',');
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
