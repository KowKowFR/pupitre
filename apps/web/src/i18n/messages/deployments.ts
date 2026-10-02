import type { Translated } from '@pupitre/core';

/**
 * Les déploiements — le journal des runs, le suivi d'un run, l'onglet
 * « Sécurité », la purge, et les refus de leurs routes.
 *
 * ── Ce qui n'entre pas ici, et pourquoi ─────────────────────────────────────
 * Les **lignes de log** affichées dans le terminal de droite viennent du worker
 * et dorment en base. Elles décrivent ce qui s'est passé sur une machine, un
 * jour donné : les traduire à l'écriture figerait la langue de l'instance au
 * moment du run, et les traduire à la lecture demanderait au panel de
 * comprendre un texte dont il n'a que la chaîne. Le **décor** autour se
 * traduit — titres, boutons, états d'étape, filtres, « défilement auto ».
 *
 * Même partage pour les scans : la description d'une CVE vient de Trivy ou de
 * Grype et reste telle quelle, comme le nom du paquet et l'identifiant. Les
 * **sévérités** (`CRITICAL`, `HIGH`…) sont affichées brutes, en majuscules :
 * ce sont les valeurs de l'énumération, pas un libellé, et un script qui filtre
 * sur `severity=HIGH` lit la même chose à l'écran. Les **verdicts**, eux, sont
 * bien des libellés — « bloquant », « conforme » — et se traduisent.
 */
const fr = {
  // ── Journal des runs ────────────────────────────────────────────────────
  'page.title': 'Déploiements',
  'page.description':
    'Chaque ligne est un run : une AppSpec figée, poussée sur une cible, avec ses scans et son verdict. Ouvrez-en un pour revoir ses étapes et ses logs.',
  'page.counter': {
    one: '{count} run · page {page}/{total}',
    other: '{count} runs · page {page}/{total}',
  },
  'page.deploy': 'Déployer',
  'page.export': 'Exporter',
  'filter.label': 'Filtrer par statut',
  'filter.all': 'Tous',
  'filter.running': 'En cours',
  'filter.failed': 'Échoués',
  'filter.rolledBack': 'Repliés',
  'filter.scanBlocked': 'Bloqués par un scan',
  'search.label': 'Rechercher un run',
  'search.placeholder': 'Application, cible, #run…',
  'filter.empty': 'Aucun run dans ce filtre.',
  'pager.timezone': 'Dates en UTC',
  'empty.title': 'Aucun déploiement',
  'empty.hint':
    "Un run naît d'une application déclarée et d'une cible au preflight vert. Commencez par la page Applications.",

  // ── Statuts. Libellés d'affichage, pas les valeurs de l'énumération. ────
  'status.pending': 'en attente',
  'status.running': 'en cours',
  'status.success': 'réussi',
  'status.failed': 'échoué',
  'status.rolled_back': 'rollback effectué',
  'status.destroyed': 'détruit',

  // ── Pastille d'étape : la forme porte le sens, le texte est pour l'ARIA.
  'step.pending': 'en attente',
  'step.running': 'en cours',
  'step.success': 'réussie',
  'step.failed': 'échouée',
  'step.skipped': 'sans objet',

  // ── Tableau ─────────────────────────────────────────────────────────────
  'table.selected': {
    one: '{count} run sélectionné',
    other: '{count} runs sélectionnés',
  },
  'table.uncheckAll': 'Tout décocher',
  'table.selectionNote': 'La purge efface la trace en base, rien sur les machines.',
  'table.blocked': {
    one: '{count} run de cette page ne se purge pas : en service ou en cours.',
    other: '{count} runs de cette page ne se purgent pas : en service ou en cours.',
  },
  'column.run': 'Run',
  'row.open': 'Ouvrir {slug} #{number}',
  'table.purgeSelection': 'Purger la sélection',
  'column.application': 'Application',
  'column.runtime': 'Runtime',
  'column.scans': 'Scans',
  'column.date': 'Date (UTC)',
  'column.by': 'Par',
  'row.select': 'Sélectionner {slug} #{number}',
  'row.purgeBlocked': 'En service ou en cours : détruisez-le avant de le purger.',

  // ── Purge ───────────────────────────────────────────────────────────────
  'purge.dialogTitle': {
    one: 'Purger {count} run de l’historique ?',
    other: 'Purger {count} runs de l’historique ?',
  },
  'purge.description':
    'La purge efface la trace en base. Elle ne touche à rien sur la machine cible.',
  'purge.computing': 'Calcul de ce qui sera effacé…',
  'purge.selectedWord': { one: 'sélectionné', other: 'sélectionnés' },
  'purge.erased': {
    one: 'run sur {total} {selected} sera effacé, avec leurs étapes, leurs logs et leurs scans.',
    other:
      'runs sur {total} {selected} seront effacés, avec leurs étapes, leurs logs et leurs scans.',
  },
  'purge.releasedPorts': {
    one: 'Port rendu à leur cible : {list}.',
    other: 'Ports rendus à leur cible : {list}.',
  },
  'purge.rollbackLost': {
    one: '{count} run perdra sa version de repli : le rollback ne sera plus proposé.',
    other: '{count} runs perdra sa version de repli : le rollback ne sera plus proposé.',
  },
  'purge.refused': { one: '{count} refusé :', other: '{count} refusés :' },
  'purge.truncated': 'Sélection tronquée à {limit} runs par appel. Relancez la purge pour finir.',
  'purge.auditNote': 'Les logs d’activité, eux, conservent la trace de ce qui a été purgé.',
  'purge.pending': 'Purge…',
  'purge.confirm': { one: 'Purger {count} run', other: 'Purger {count} runs' },
  'purge.summary.purged': { one: '{count} run purgé', other: '{count} runs purgés' },
  'purge.summary.refused': { one: '{count} refusé', other: '{count} refusés' },
  'purge.summary.ports': {
    one: 'port libéré : {list}',
    other: 'ports libérés : {list}',
  },

  // ── Verdicts de scan ────────────────────────────────────────────────────
  'verdict.fail': 'bloquant',
  'verdict.pass': 'conforme',
  'verdict.unknown': 'indéterminé',
  'verdict.error': 'en erreur',
  'verdict.running': 'en cours',

  // ── Suivi d'un run ──────────────────────────────────────────────────────
  'loading.label': 'Chargement du déploiement',
  'detail.description': 'Déployé sur {target} ({host}) en {runtime}.',
  'tab.pipeline': 'Pipeline',
  'tab.security': 'Sécurité',
  'tab.spec': 'AppSpec figée',
  'tab.label': 'Vues du run',
  'spec.note':
    'L’AppSpec telle qu’elle est partie avec ce run. La modifier ensuite ne change rien à ce qu’il a déployé.',
  'spec.none': 'Aucune AppSpec figée pour ce run.',
  'field.duration': 'Durée',
  'field.by': 'Lancé par',
  'progress.label': 'Avancement du pipeline',
  'step.detail.scan': '{critical} critique · {high} élevée',
  'drawer.kind': 'Déploiement',
  'drawer.pipeline': 'Pipeline',
  'drawer.security': 'Sécurité',
  'drawer.context': 'Contexte',
  'drawer.application': 'Application',
  'drawer.target': 'Cible',
  'drawer.runtime': 'Runtime',
  'drawer.date': 'Date (UTC)',
  'drawer.loading': 'Lecture des étapes…',
  'drawer.failed': 'Étapes illisibles (HTTP {status})',
  'drawer.openTrace': 'Ouvrir la trace complète',
  'drawer.scan.summary': '{scanners} · pire sévérité {worst}',
  'drawer.scan.worstNone': 'aucune',
  'drawer.scan.none': 'Aucun scan pour ce run.',
  'rollback.title': 'Revenir à la version précédente ?',
  'rollback.lead': '{slug} reprend sur {target} la release qui tournait avant ce run.',
  'rollback.toast': 'Retour en arrière de {slug} enfilé',
  'destroy.toast': 'Destruction de {slug} sur {target} enfilée',
  'pipeline.title': 'Pipeline',
  'pipeline.succeeded': '{done} sur {total} réussies',

  'logs.title': 'Flux de logs',
  'logs.lines': { one: '{count} ligne', other: '{count} lignes' },
  'logs.export': 'Exporter',
  'logs.export.text': 'texte horodaté, lisible',
  'logs.export.jsonl': 'une ligne = un objet JSON',
  'logs.export.scope':
    'Toutes les lignes conservées en base pour ce déploiement, pas seulement celles affichées.',
  'logs.autoScroll': 'Défilement auto',
  'logs.empty.settled': 'Aucun log conservé pour ce déploiement.',
  'logs.empty.waiting': 'En attente du worker…',

  'connection.connecting': 'connexion…',
  'connection.live': 'flux en direct',
  'connection.closed': 'flux terminé',
  'connection.error': 'reconnexion…',

  'field.step': 'Étape',
  'field.address': 'Adresse',

  'action.rollback': 'Revenir à la version précédente',
  'action.rollback.pending': 'Rollback…',
  'action.destroy': 'Détruire',
  'action.destroy.pending': 'Destruction…',
  'action.unblock': 'Ce déploiement est figé ?',

  'banner.restored.version': 'Version {version} restaurée — le service répond.',
  'banner.restored': 'Version précédente restaurée — le service répond.',
  'banner.noFallback':
    'Rollback automatique demandé, mais aucune version antérieure sur cette cible.',

  // ── Onglet Sécurité ─────────────────────────────────────────────────────
  'scans.unavailable': 'Scans indisponibles (HTTP {status})',
  'scans.empty.title': 'Aucun scan',
  'scans.empty.noScanner':
    'Aucun scanner n’a été sélectionné pour ce déploiement : l’étape a été sautée.',
  'scans.empty.hint':
    'Aucun scan n’est attaché à ce déploiement. Le pipeline, dans l’onglet voisin, dit si l’étape d’analyse a été sautée ou si le run s’est arrêté avant de l’atteindre.',
  'scans.vulnerabilities': '{scanner} — vulnérabilités',
  'scans.sbom.noVulnerability': 'Un inventaire de composants n’énonce aucune vulnérabilité.',
  'scans.findings.summary': {
    one: '{count} finding{filter} · {image}',
    other: '{count} findings{filter} · {image}',
  },
  'scans.findings.filter': 'de sévérité {severity}',
  'scans.findings.empty': 'Aucun finding à afficher.',
  'scans.severity.all': 'Toutes sévérités',
  'scans.sbom.hint': 'Le document est téléchargeable depuis la carte ci-dessus.',
  'scans.run.meta': '{image} · {duration} · seuil {failOn}',
  'scans.sbom.download': 'Télécharger le SBOM',
  'column.severity': 'Sévérité',
  'column.cve': 'CVE',
  'column.package': 'Paquet',
  'column.version': 'Version',
  'column.fix': 'Correctif',
  'column.title': 'Intitulé',
  'findings.noFix': 'aucun',

  // ── Refus des routes ────────────────────────────────────────────────────
  'error.notFound': 'Déploiement « {id} » introuvable',
  'error.applicationNotFound': 'Application « {id} » introuvable',
  'error.targetNotFound': 'Cible « {id} » introuvable',
  'error.scanNotFound': 'Scan « {id} » introuvable',
  'error.enqueueFailed': "La tâche n'a pas reçu d'identifiant",
  'error.running': 'Ce déploiement est en cours. Attendez qu’il se termine.',
  'error.inProgress': 'Ce déploiement est en cours.',
  'error.alreadyDestroyed': 'Ce déploiement est déjà détruit.',
  'error.noPrevious':
    "Aucun déploiement précédent réussi sur cette cible : il n'y a nulle part où revenir.",
  'error.neverPreflighted':
    "La cible « {target} » n'a jamais été testée. Lancez un preflight avant de déployer.",
  /**
   * Deux clés plutôt qu'un « aucun » passé en variable : un mot injecté dans un
   * gabarit n'est pas traduisible — il arriverait en français dans la phrase
   * anglaise. Même arbitrage que `rate_limited.window` / `.period`.
   */
  'error.runtimeUnavailable':
    "Le runtime « {runtime} » n'est pas disponible sur « {target} ». Runtimes exploitables : {available}.",
  'error.runtimeUnavailable.none':
    "Le runtime « {runtime} » n'est pas disponible sur « {target} ». Runtimes exploitables : aucun.",
  'error.alreadySettled':
    "Ce déploiement est déjà conclu (« {status} ») : il n'y a rien à débloquer.",
  'error.settledWhileChecking':
    "Ce déploiement s'est conclu pendant la vérification : rien à débloquer.",
  'error.settledWhileUnblocking':
    "Ce déploiement s'est conclu pendant le déblocage : son statut n'a pas été touché.",

  /**
   * Le refus de déblocage. Il **nomme** la tâche qui innocente le déploiement :
   * « elle existe » ne serait pas une réponse.
   */
  'unblock.refusal.job': {
    one: "Ce déploiement n'est pas figé : sa tâche « {name} » (#{id}) est toujours dans la file « ops », à l'état « {state} ». Un déploiement peut légitimement durer plusieurs minutes — un build, le téléchargement d'une grosse image, une application qui met du temps à répondre. Celui-ci en est à {count} minute. Attendez son verdict, ou détruisez-le une fois qu'il l'aura rendu.",
    other:
      "Ce déploiement n'est pas figé : sa tâche « {name} » (#{id}) est toujours dans la file « ops », à l'état « {state} ». Un déploiement peut légitimement durer plusieurs minutes — un build, le téléchargement d'une grosse image, une application qui met du temps à répondre. Celui-ci en est à {count} minutes. Attendez son verdict, ou détruisez-le une fois qu'il l'aura rendu.",
  },
  'unblock.refusal.tooRecent':
    "Ce déploiement vient d'être créé ({seconds} s) : sa tâche n'a peut-être pas encore été enfilée. Réessayez dans une minute.",

  'error.sbomUnsupported': '« {scanner} » ne produit pas de SBOM.',
  'error.sbomIncomplete': "Le scan « {scanner} » n'a pas abouti : aucun SBOM à télécharger.",
  'error.sbomMissing': 'Aucun SBOM enregistré pour ce scan.',
} as const;

const en: Translated<typeof fr> = {
  'page.title': 'Deployments',
  'page.description':
    'Each row is a run: a frozen AppSpec pushed to a target, with its scans and its verdict. Open one to review its steps and its logs.',
  'page.counter': {
    one: '{count} run · page {page}/{total}',
    other: '{count} runs · page {page}/{total}',
  },
  'page.deploy': 'Deploy',
  'page.export': 'Export',
  'filter.label': 'Filter by status',
  'filter.all': 'All',
  'filter.running': 'Running',
  'filter.failed': 'Failed',
  'filter.rolledBack': 'Rolled back',
  'filter.scanBlocked': 'Blocked by a scan',
  'search.label': 'Search runs',
  'search.placeholder': 'Application, target, #run…',
  'filter.empty': 'No run in this filter.',
  'pager.timezone': 'Dates in UTC',
  'empty.title': 'No deployment',
  'empty.hint':
    'A run needs a declared application and a target with a green preflight. Start from the Applications page.',

  'status.pending': 'pending',
  'status.running': 'running',
  'status.success': 'succeeded',
  'status.failed': 'failed',
  'status.rolled_back': 'rolled back',
  'status.destroyed': 'destroyed',

  'step.pending': 'pending',
  'step.running': 'running',
  'step.success': 'succeeded',
  'step.failed': 'failed',
  'step.skipped': 'not applicable',

  'table.selected': {
    one: '{count} run selected',
    other: '{count} runs selected',
  },
  'table.uncheckAll': 'Uncheck all',
  'table.selectionNote': 'Purging erases the record in the database, nothing on the hosts.',
  'table.blocked': {
    one: '{count} run on this page cannot be purged: live or still running.',
    other: '{count} runs on this page cannot be purged: live or still running.',
  },
  'column.run': 'Run',
  'row.open': 'Open {slug} #{number}',
  'table.purgeSelection': 'Purge selection',
  'column.application': 'Application',
  'column.runtime': 'Runtime',
  'column.scans': 'Scans',
  'column.date': 'Date (UTC)',
  'column.by': 'By',
  'row.select': 'Select {slug} #{number}',
  'row.purgeBlocked': 'Live or still running: destroy it before purging.',

  'purge.dialogTitle': {
    one: 'Purge {count} run from the history?',
    other: 'Purge {count} runs from the history?',
  },
  'purge.description':
    'Purging erases the record in the database. It touches nothing on the target machine.',
  'purge.computing': 'Working out what will be erased…',
  'purge.selectedWord': { one: 'selected', other: 'selected' },
  'purge.erased': {
    one: 'run of {total} {selected} will be erased, with its steps, its logs and its scans.',
    other:
      'runs of {total} {selected} will be erased, with their steps, their logs and their scans.',
  },
  'purge.releasedPorts': {
    one: 'Port returned to its target: {list}.',
    other: 'Ports returned to their targets: {list}.',
  },
  'purge.rollbackLost': {
    one: '{count} run will lose its fallback version: rollback will no longer be offered.',
    other: '{count} runs will lose their fallback version: rollback will no longer be offered.',
  },
  'purge.refused': { one: '{count} refused:', other: '{count} refused:' },
  'purge.truncated': 'Selection capped at {limit} runs per call. Run the purge again to finish.',
  'purge.auditNote': 'The activity log still keeps a record of what was purged.',
  'purge.pending': 'Purging…',
  'purge.confirm': { one: 'Purge {count} run', other: 'Purge {count} runs' },
  'purge.summary.purged': { one: '{count} run purged', other: '{count} runs purged' },
  'purge.summary.refused': { one: '{count} refused', other: '{count} refused' },
  'purge.summary.ports': {
    one: 'port released: {list}',
    other: 'ports released: {list}',
  },

  'verdict.fail': 'blocking',
  'verdict.pass': 'clear',
  'verdict.unknown': 'inconclusive',
  'verdict.error': 'errored',
  'verdict.running': 'running',

  'loading.label': 'Loading the deployment',
  'detail.description': 'Deployed to {target} ({host}) on {runtime}.',
  'tab.pipeline': 'Pipeline',
  'tab.security': 'Security',
  'tab.spec': 'Frozen AppSpec',
  'tab.label': 'Run views',
  'spec.note':
    'The AppSpec as it left with this run. Editing it afterwards changes nothing about what it deployed.',
  'spec.none': 'No frozen AppSpec for this run.',
  'field.duration': 'Duration',
  'field.by': 'Started by',
  'progress.label': 'Pipeline progress',
  'step.detail.scan': '{critical} critical · {high} high',
  'drawer.kind': 'Deployment',
  'drawer.pipeline': 'Pipeline',
  'drawer.security': 'Security',
  'drawer.context': 'Context',
  'drawer.application': 'Application',
  'drawer.target': 'Target',
  'drawer.runtime': 'Runtime',
  'drawer.date': 'Date (UTC)',
  'drawer.loading': 'Reading the steps…',
  'drawer.failed': 'Cannot read the steps (HTTP {status})',
  'drawer.openTrace': 'Open the full trace',
  'drawer.scan.summary': '{scanners} · worst severity {worst}',
  'drawer.scan.worstNone': 'none',
  'drawer.scan.none': 'No scan for this run.',
  'rollback.title': 'Go back to the previous version?',
  'rollback.lead': '{slug} resumes on {target} the release that ran before this run.',
  'rollback.toast': 'Rollback of {slug} queued',
  'destroy.toast': 'Destruction of {slug} on {target} queued',
  'pipeline.title': 'Pipeline',
  'pipeline.succeeded': '{done} of {total} succeeded',

  'logs.title': 'Log stream',
  'logs.lines': { one: '{count} line', other: '{count} lines' },
  'logs.export': 'Export',
  'logs.export.text': 'timestamped, readable text',
  'logs.export.jsonl': 'one line = one JSON object',
  'logs.export.scope':
    'Every line kept in the database for this deployment, not only the ones shown.',
  'logs.autoScroll': 'Auto-scroll',
  'logs.empty.settled': 'No log kept for this deployment.',
  'logs.empty.waiting': 'Waiting for the worker…',

  'connection.connecting': 'connecting…',
  'connection.live': 'live stream',
  'connection.closed': 'stream ended',
  'connection.error': 'reconnecting…',

  'field.step': 'Step',
  'field.address': 'Address',

  'action.rollback': 'Go back to the previous version',
  'action.rollback.pending': 'Rolling back…',
  'action.destroy': 'Destroy',
  'action.destroy.pending': 'Destroying…',
  'action.unblock': 'Is this deployment stuck?',

  'banner.restored.version': 'Version {version} restored — the service answers.',
  'banner.restored': 'Previous version restored — the service answers.',
  'banner.noFallback':
    'Automatic rollback was asked for, but there is no earlier version on this target.',

  'scans.unavailable': 'Scans unavailable (HTTP {status})',
  'scans.empty.title': 'No scan',
  'scans.empty.noScanner': 'No scanner was selected for this deployment: the step was skipped.',
  'scans.empty.hint':
    'No scan is attached to this deployment. The pipeline, in the next tab, says whether the scan step was skipped or the run stopped before reaching it.',
  'scans.vulnerabilities': '{scanner} — vulnerabilities',
  'scans.sbom.noVulnerability': 'A component inventory states no vulnerability.',
  'scans.findings.summary': {
    one: '{count} finding{filter} · {image}',
    other: '{count} findings{filter} · {image}',
  },
  'scans.findings.filter': 'with severity {severity}',
  'scans.findings.empty': 'No finding to show.',
  'scans.severity.all': 'All severities',
  'scans.sbom.hint': 'The document downloads from the card above.',
  'scans.run.meta': '{image} · {duration} · threshold {failOn}',
  'scans.sbom.download': 'Download the SBOM',
  'column.severity': 'Severity',
  'column.cve': 'CVE',
  'column.package': 'Package',
  'column.version': 'Version',
  'column.fix': 'Fix',
  'column.title': 'Title',
  'findings.noFix': 'none',

  'error.notFound': 'Deployment “{id}” not found',
  'error.applicationNotFound': 'Application “{id}” not found',
  'error.targetNotFound': 'Target “{id}” not found',
  'error.scanNotFound': 'Scan “{id}” not found',
  'error.enqueueFailed': 'The job got no ID',
  'error.running': 'This deployment is running. Wait for it to finish.',
  'error.inProgress': 'This deployment is running.',
  'error.alreadyDestroyed': 'This deployment is already destroyed.',
  'error.noPrevious':
    'No earlier successful deployment on this target: there is nowhere to go back to.',
  'error.neverPreflighted':
    'Target “{target}” has never been tested. Run a preflight before deploying.',
  'error.runtimeUnavailable':
    'Runtime “{runtime}” is not available on “{target}”. Usable runtimes: {available}.',
  'error.runtimeUnavailable.none':
    'Runtime “{runtime}” is not available on “{target}”. No runtime is usable there.',
  'error.alreadySettled':
    'This deployment is already settled (“{status}”): there is nothing to unblock.',
  'error.settledWhileChecking':
    'This deployment settled while it was being checked: nothing to unblock.',
  'error.settledWhileUnblocking':
    'This deployment settled while it was being unblocked: its status was left alone.',

  'unblock.refusal.job': {
    one: 'This deployment is not stuck: its job “{name}” (#{id}) is still in the “ops” queue, in state “{state}”. A deployment can legitimately take several minutes — a build, a large image to pull, an app slow to answer. This one is {count} minute in. Wait for its verdict, or destroy it once it has ruled.',
    other:
      'This deployment is not stuck: its job “{name}” (#{id}) is still in the “ops” queue, in state “{state}”. A deployment can legitimately take several minutes — a build, a large image to pull, an app slow to answer. This one is {count} minutes in. Wait for its verdict, or destroy it once it has ruled.',
  },
  'unblock.refusal.tooRecent':
    'This deployment was just created ({seconds} s): its job may not be queued yet. Try again in a minute.',

  'error.sbomUnsupported': '“{scanner}” produces no SBOM.',
  'error.sbomIncomplete': 'Scan “{scanner}” did not complete: no SBOM to download.',
  'error.sbomMissing': 'No SBOM stored for this scan.',
};

export const deployments = { fr, en };
