import type { Translated } from '@pupitre/core';

/**
 * Scheduled tasks — the table, the cadence field and the help.
 *
 * Each type's name, description and negative guarantee live in
 * `packages/core/src/schedule.ts`: the worker installs the same tasks, there must
 * not be two inventories. This module carries everything else.
 *
 * The labels of the help's table are cut into fragments where the sentence
 * crosses a `<Code>` or a `<strong>`. It is ugly in the dictionary and right on
 * screen: putting markup in a translatable string always costs more.
 */
const fr = {
  // ── Header ──────────────────────────────────────────────────────────────
  'page.title': 'Tâches planifiées',
  'page.description':
    'Ce que le panel refait tout seul sur ce qui est déjà déployé : ré-analyser les images, sonder la santé des applications, rafraîchir le preflight des cibles, purger les vieilles versions. Ordonnancées par BullMQ — pas par un cron Linux — et donc visibles, rejouables et traçables ici. Aucune ne redéploie, ne rollback ni ne bloque quoi que ce soit : elles constatent et alertent.',

  // ── Bandeau d'introduction ──────────────────────────────────────────────
  'banner.a':
    "Chaque tâche porte son propre fuseau, et c'est lui qui décide de l'heure à laquelle elle part : une tâche neuve hérite de ",
  'banner.b':
    ", le fuseau des paramètres d'instance, puis vit sa vie. « Lancer » enfile une occurrence immédiate sans déplacer la prochaine, et fonctionne même sur une tâche désactivée — de quoi l'essayer avant de l'activer.",

  // ── Creation form ───────────────────────────────────────────────────────
  'page.schedule': 'Planifier une tâche',
  'drawer.kind': 'Tâche planifiée',
  'status.success': 'réussi',
  'status.running': 'en cours',
  'status.failed': 'échoué',
  'status.skipped': 'ignoré',
  'status.pending': 'en attente',
  'row.more': 'Historique, désactiver, supprimer',
  'row.lastRun.none': 'jamais lancée',
  'delete.title': 'Supprimer la tâche « {key} » ?',
  'delete.schedule': 'Son scheduler est retiré de BullMQ : plus aucune occurrence ne partira.',
  'delete.history': "Son historique d'exécutions part avec elle.",
  'delete.confirm': 'Supprimer la tâche',
  'dialog.save': 'Enregistrer la cadence',
  'preview.title': 'Aperçu',
  'preview.list': 'Puis',
  'create.type.label': 'Type',
  'create.key.label': 'Clé BullMQ',
  'create.key.hint':
    "L'identifiant du scheduler dans Redis. Unique, et c'est ce nom qu'on retrouve dans les logs du worker.",
  'create.submit': 'Planifier',
  'create.description':
    "Une tâche répète un constat à la cadence choisie. Elle ne redéploie rien et ne bloque rien : elle mesure et alerte.",
  'create.invalid': "La cadence n'est pas valide : corrigez-la ci-dessus.",

  // ── Table ───────────────────────────────────────────────────────────────
  empty:
    'Aucune tâche planifiée. Les scans périodiques, les healthchecks et la purge des versions ne tournent que si vous les installez ici.',
  'column.job': 'Tâche',
  'column.cadence': 'Cadence',
  'column.lastRun': 'Dernier run',
  'column.nextRun': 'Prochain run',
  'row.noSimpleForm': 'expression sans équivalent simple',
  'row.zoneDrift': "BullMQ l'interprète encore en {zone}",
  'row.manualSuffix': ' · manuel',
  'row.yourClock': '{clock} chez vous',
  'row.active': 'active',
  'row.disabled': 'désactivée',
  'row.missingFromBullmq': 'absente de BullMQ — le worker la réinstallera au démarrage',
  'row.hideHistory': 'Masquer',
  'row.showHistory': 'Historique',
  'row.editCadence': 'Cadence',
  'row.runNow': 'Lancer',
  'history.empty': 'Aucune exécution enregistrée.',
  'history.manual': 'déclenchée à la main',

  // ── Retours d'action ────────────────────────────────────────────────────
  'notice.created': 'Tâche « {key} » planifiée',
  'notice.triggered': '« {key} » lancée',
  'notice.enabled': '« {key} » activée',
  'notice.disabled': '« {key} » désactivée',
  'notice.deleted': '« {key} » supprimée',
  'notice.cadenceUpdated': 'Cadence de « {key} » modifiée',

  // ── Dialogue de cadence ─────────────────────────────────────────────────
  'dialog.title': 'Cadence de « {key} »',
  'dialog.expertOnly':
    "L'expression enregistrée n'a pas d'équivalent en mode simple : l'écran s'ouvre en mode expert plutôt que d'afficher une périodicité approchée.",

  // ── Champ de cadence ────────────────────────────────────────────────────
  'field.label': 'Cadence',
  'field.kind.label': 'Périodicité',
  'field.mode.aria': 'Mode de saisie de la cadence',
  'field.mode.simple': 'Simple',
  'field.mode.expert': 'Expert',
  'field.timeZone.label': 'Fuseau',
  'field.timeZone.unknown': '{zone} (inconnu de ce serveur)',
  'field.timeZone.irrelevant':
    "Cette cadence est un intervalle : elle ne dépend d'aucun fuseau. Le réglage est conservé pour le jour où elle devient une heure fixe.",
  'field.kind.interval': 'Toutes les quelques minutes',
  'field.kind.hourly': 'Toutes les heures',
  'field.kind.daily': 'Tous les jours',
  'field.kind.weekly': 'Certains jours de la semaine',
  'field.kind.monthly': 'Une fois par mois',
  'field.interval.aria': 'Intervalle en minutes',
  'field.interval.option': 'toutes les {minutes} min',
  'field.hourly.atMinute': 'à la minute',
  'field.monthly.onDay': 'le',
  'field.weekdays.aria': 'Jours de la semaine',
  'field.time.at': 'à',
  'field.cron.aria': 'Expression cron',
  'field.expertNoSimple':
    "Cette expression n'a pas d'équivalent en mode simple — plages, pas d'heure ou listes de minutes n'y sont pas représentables. Repasser en mode simple la remplacerait.",
  'field.shortMonths':
    "Le {day} n'existe pas tous les mois : ceux qui sont plus courts sont simplement sautés.",

  'weekday.1.short': 'L',
  'weekday.1.long': 'lundi',
  'weekday.2.short': 'M',
  'weekday.2.long': 'mardi',
  'weekday.3.short': 'M',
  'weekday.3.long': 'mercredi',
  'weekday.4.short': 'J',
  'weekday.4.long': 'jeudi',
  'weekday.5.short': 'V',
  'weekday.5.long': 'vendredi',
  'weekday.6.short': 'S',
  'weekday.6.long': 'samedi',
  'weekday.0.short': 'D',
  'weekday.0.long': 'dimanche',

  // ── Preview ─────────────────────────────────────────────────────────────
  'preview.emptyCron': 'cadence vide',
  'preview.refused':
    "Expression refusée : {error}. Rien ne sera planifié tant qu'elle n'est pas valide.",
  'preview.computing': 'Prochaines exécutions : calcul en cours…',
  'preview.noRun': "Aucune exécution dans les 366 prochains jours — vérifiez l'expression.",
  'preview.next': 'Prochaine',

  // ── Aide ────────────────────────────────────────────────────────────────
  'help.trigger': 'À quoi servent les tâches planifiées ?',
  'help.title': 'À quoi servent les tâches planifiées ?',
  'help.subtitle':
    "Ce qui doit se répéter sans que personne ne clique. Elles constatent et alertent — aucune n'agit sur vos déploiements.",

  'help.idea.title': 'L’idée directrice',
  'help.idea.p1':
    "Un déploiement est un évènement : on le déclenche, il aboutit, on passe à autre chose. Mais une image scannée sans faille il y a trois semaines en a peut-être une aujourd'hui, un conteneur en service a pu mourir sans témoin, et les répertoires de version s'empilent sur la cible jusqu'à remplir le disque. Les tâches planifiées sont ce qui regarde tout cela à intervalle régulier.",
  'help.idea.p2.a': 'Règle commune et non négociable : ',
  'help.idea.p2.strong': "aucune n'agit",
  'help.idea.p2.b':
    ". Un scan qui remonte une CRITICAL ne bloque rien et ne redéploie rien ; un healthcheck en échec ne déclenche aucun rollback. Le panel informe, l'opérateur décide. La seule exception est la purge des répertoires de version, explicitement demandée et qui ne touche jamais la version courante.",

  'help.types.title': 'Ce que fait chaque type',
  'help.types.column.type': 'Type',
  'help.types.column.what': 'Ce qui se passe',
  'help.types.column.payload': 'Paramètres (payload)',
  'help.types.default': 'par défaut : ',

  'help.scan.steps.a': 'Parcourt les déploiements ',
  'help.scan.steps.current': 'courants',
  'help.scan.steps.b':
    ", ouvre une session SSH sur chaque cible, demande au driver la liste des images en service, puis relance les scanners configurés pour l'application. Les rapports s'",
  'help.scan.steps.stack': 'empilent',
  'help.scan.steps.c':
    " au lieu de remplacer les précédents : c'est ce qui permet de voir une image inchangée se dégrader au fil des semaines.",
  'help.scan.payload.a': ' et ',
  'help.scan.payload.b': ' pour forcer la configuration ;',
  'help.scan.payload.c': ' / ',
  'help.scan.payload.d':
    " pour restreindre le champ. Sans scanner configuré, l'application est sautée — la tâche n'en impose aucun.",

  'help.healthcheck.steps.a': 'Sonde chaque déploiement courant par ',
  'help.healthcheck.steps.b': ' et écrit le résultat (',
  'help.healthcheck.steps.c': ', ',
  'help.healthcheck.steps.d': ") dans l'historique de santé du déploiement.",
  'help.healthcheck.payload.a': ' / ',
  'help.healthcheck.payload.b': ' uniquement.',

  'help.cleanup.steps.a':
    'Demande à chaque driver de purger ses répertoires de version sur la cible, au-delà des ',
  'help.cleanup.steps.b':
    " plus récents. La tâche ne nomme aucun chemin et ne sait pas sur quel runtime elle tourne : c'est le driver qui sait où il dépose ses releases.",
  'help.cleanup.payload.a': ' (1 à 50, défaut 5) ; ',
  'help.cleanup.payload.b': ' / ',

  'help.preflight.steps.a': 'Balaye les cibles enregistrées et ',
  'help.preflight.steps.queue': 'enfile',
  'help.preflight.steps.b': ' un ',
  'help.preflight.steps.c':
    " par cible. Elle ne fait pas le preflight elle-même : elle réutilise la tâche existante, pour qu'il n'y ait qu'une implémentation et qu'un endroit où un credential est déchiffré.",
  'help.preflight.payload': " pour ne rafraîchir qu'une partie du parc.",
  'help.backup.steps.a':
    'Pour chaque application dont la sauvegarde automatique est activée, et chaque cible où elle tourne, ',
  'help.backup.steps.queue': 'enfile',
  'help.backup.steps.b': ' une sauvegarde sur la file ',
  'help.backup.steps.c':
    " : export des bases reconnues, archive des volumes, chiffrés et déposés sur la destination. Le détail de chacune est sur la fiche de l'application.",
  'help.backup.payload.a': ' ou ',
  'help.backup.payload.b': " pour n'en sauvegarder qu'une partie.",
  'help.panel_backup.steps.a': 'Exporte la base de Pupitre avec ',
  'help.panel_backup.steps.b':
    ', la chiffre et la dépose sur la destination. Elle ne contient pas ',
  'help.panel_backup.steps.c':
    ' : gardez cette clé ailleurs, sans elle aucune sauvegarde ne se relit.',
  'help.panel_backup.payload': 'Aucun paramètre.',

  'help.when.title': 'Quand elles tournent',
  'help.when.a': "L'ordonnanceur est ",
  'help.when.bullmq': 'BullMQ',
  'help.when.b': ', pas un cron Linux : chaque tâche active est un ',
  'help.when.scheduler': 'job scheduler',
  'help.when.c':
    " Redis, et c'est lui qui calcule la prochaine occurrence. La base reste la source de vérité — au démarrage du worker, tout est réconcilié : une tâche active absente de Redis y est réinstallée, une tâche désactivée ou supprimée en est retirée. La colonne ",
  'help.when.state': 'État',
  'help.when.d': " signale l'écart quand il existe.",

  'help.zone.title': 'Le fuseau, réglage de la tâche',
  'help.zone.p1.strong': 'Chaque tâche porte son propre fuseau',
  'help.zone.p1.a': ', enregistré à côté de son expression cron et transmis à BullMQ en ',
  'help.zone.p1.b': '. Une tâche réglée « à 3 h » en ',
  'help.zone.p1.c':
    " tourne bien à 3 h à Paris — et l'instant UTC correspondant change avec l'heure d'été, ce qui est précisément le but. Le fuseau du process qui ordonnance n'entre plus en jeu.",
  'help.zone.p2.a': 'Une tâche neuve part de ',
  'help.zone.p2.b':
    ", le fuseau des paramètres d'instance : celui que vous avez déjà déclaré une fois. Le sélecteur du formulaire permet d'en choisir un autre, tâche par tâche — utile quand une purge doit tomber la nuit d'une machine qui n'est pas dans votre fuseau. L'aperçu sous le champ montre l'heure dans le fuseau de la tâche, et sur votre horloge quand les deux diffèrent.",
  'help.zone.legacy.a': 'Les tâches antérieures à ce réglage sont en ',
  'help.zone.legacy.b':
    ' — pas en {zone}. Elles ont été installées quand le motif était passé à BullMQ sans option ',
  'help.zone.legacy.c':
    ", donc interprété dans le fuseau du process, qui est UTC dans nos conteneurs. Leur appliquer d'office le fuseau d'instance aurait déplacé leur exécution de plusieurs heures sans que personne ne l'ait demandé. Changez-le explicitement si ce n'est pas ce que vous vouliez : la prochaine occurrence est aussitôt recalculée.",

  'help.modes.title': 'Simple ou expert',
  'help.modes.p1':
    "Le mode simple n'est qu'une aide à la saisie : ce qui est enregistré reste une expression cron, la même que celle du mode expert. Il n'y a donc rien à choisir une fois pour toutes — une tâche créée en mode simple se relit en mode expert, et l'inverse quand l'expression a un équivalent simple.",
  'help.modes.p2.a': "Certaines expressions n'en ont pas : ",
  'help.modes.p2.b':
    " mélange un pas de 7 minutes, une plage d'heures et une liste de jours. L'écran reste alors en mode expert et le dit, plutôt que d'afficher une périodicité approchée qui serait fausse. La phrase sous le champ, elle, décrit toujours l'expression réelle.",

  'help.actions.title': 'Déclencher, désactiver, supprimer',
  'help.actions.run': 'Lancer',
  'help.actions.run.a': ' enfile une occurrence immédiate, marquée ',
  'help.actions.run.manual': 'manuel',
  'help.actions.run.b':
    " dans l'historique. Elle s'exécute même si la tâche est désactivée — c'est exactement ce qu'on veut en réglant une tâche.",
  'help.actions.disable': 'Désactiver',
  'help.actions.disable.text':
    " retire le scheduler de Redis mais garde la ligne, son historique et son paramétrage. Une occurrence qui arriverait malgré tout est ignorée : le worker relit la base avant d'exécuter.",
  'help.actions.delete': 'Supprimer',
  'help.actions.delete.text':
    " retire la ligne et le scheduler. L'action est tracée dans les logs, comme la création et chaque modification de cadence.",

  'help.cadence.title': 'Bien choisir la cadence',
  'help.cadence.column.job': 'Tâche',
  'help.cadence.column.value': 'Cadence raisonnable',
  'help.cadence.column.why': 'Pourquoi',
  'help.cadence.healthcheck.job': 'Healthcheck',
  'help.cadence.healthcheck.value': 'toutes les 5 à 15 minutes',
  'help.cadence.healthcheck.why.a':
    'Chaque occurrence ouvre une session SSH par déploiement. Toutes les minutes, on épuise ',
  'help.cadence.healthcheck.why.b': " sur la cible pour n'apprendre rien de plus.",
  'help.cadence.scan.job': 'Scan périodique',
  'help.cadence.scan.value': 'une fois par nuit',
  'help.cadence.scan.why':
    'Les bases de vulnérabilités sont mises à jour au mieux quotidiennement. Scanner plus souvent coûte du CPU sur la cible pour le même rapport.',
  'help.cadence.cleanup.job': 'Purge des versions',
  'help.cadence.cleanup.value': 'une fois par nuit',
  'help.cadence.cleanup.why':
    'Décalée du scan, pour ne pas faire tourner les deux en même temps sur la même machine.',
  'help.cadence.preflight.job': 'Rafraîchissement des cibles',
  'help.cadence.preflight.value': 'toutes les heures',
  'help.cadence.preflight.why':
    "Une cible ne change pas de runtime quatre fois par heure. L'heure suffit à repérer une machine devenue injoignable.",

  'help.syntax.title': 'La syntaxe cron, pour le mode expert',
  'help.syntax.note.a': 'Un sixième champ, placé ',
  'help.syntax.note.before': 'devant',
  'help.syntax.note.b':
    ", désigne les secondes. Il est accepté mais rarement utile : une tâche qui a besoin de la seconde près n'est pas une tâche planifiée.",
  'help.cheatsheet': `┌─ minute        0-59
│ ┌─ heure       0-23
│ │ ┌─ jour      1-31   (du mois)
│ │ │ ┌─ mois    1-12   ou jan-dec
│ │ │ │ ┌─ jour  0-7    (de la semaine, 0 et 7 = dimanche) ou sun-sat
│ │ │ │ │
* * * * *

*        toute valeur              │  */15    un pas : 0, 15, 30, 45
5        une valeur                │  2-5     une plage : 2, 3, 4, 5
1,3,5    une liste                 │  2-8/2   une plage avec un pas : 2, 4, 6, 8

*/15 * * * *     toutes les 15 minutes
0 * * * *        toutes les heures, à l'heure pile
30 3 * * *       tous les jours à 03:30
0 4 * * 1        tous les lundis à 04:00
0 4 * * 1-5      du lundi au vendredi à 04:00     (pas d'équivalent simple)
0 2 1 * *        le 1er de chaque mois à 02:00

Attention : jour du mois ET jour de semaine renseignés se combinent en OU.
« 0 3 1 * 1 » tourne le 1er du mois *et* tous les lundis.`,

  // ── Erreurs d'API ───────────────────────────────────────────────────────
  'error.keyTaken': 'Une tâche planifiée « {key} » existe déjà',
  'error.notFound': 'Aucune tâche planifiée « {id} »',
  'error.queueJobNotFound': 'Aucune tâche « {id} » dans la queue ops',
  'error.noJobId': "La tâche n'a pas reçu d'identifiant",
} as const;

const en: Translated<typeof fr> = {
  'page.title': 'Scheduled jobs',
  'page.description':
    'What the panel redoes on its own over what is already deployed: scan the images again, probe application health, refresh target preflight, purge old versions. Scheduled by BullMQ — not by a Linux cron — and therefore visible, replayable and traceable here. None of them redeploys, rolls back or blocks anything: they observe and alert.',

  'banner.a':
    'Every job carries its own time zone, and that is what decides when it fires : a new job inherits ',
  'banner.b':
    ', the instance time zone, then lives its own life. “Run now” queues an immediate occurrence without moving the next one, and works even on a disabled job — enough to try it before turning it on.',

  'page.schedule': 'Schedule a job',
  'drawer.kind': 'Scheduled job',
  'status.success': 'succeeded',
  'status.running': 'running',
  'status.failed': 'failed',
  'status.skipped': 'skipped',
  'status.pending': 'pending',
  'row.more': 'History, disable, delete',
  'row.lastRun.none': 'never run',
  'delete.title': 'Delete the job “{key}”?',
  'delete.schedule': 'Its scheduler is removed from BullMQ: no occurrence will leave anymore.',
  'delete.history': 'Its run history goes with it.',
  'delete.confirm': 'Delete the job',
  'dialog.save': 'Save the cadence',
  'preview.title': 'Preview',
  'preview.list': 'Then',
  'create.type.label': 'Type',
  'create.key.label': 'BullMQ key',
  'create.key.hint':
    'The scheduler ID in Redis. Unique, and it is the name you find again in the worker logs.',
  'create.submit': 'Schedule',
  'create.description':
    'A job repeats a check at the chosen cadence. It redeploys nothing and blocks nothing: it measures and alerts.',
  'create.invalid': 'The cadence is not valid: fix it above.',

  empty:
    'No scheduled job. Periodic scans, healthchecks and the version purge run only if you install them here.',
  'column.job': 'Job',
  'column.cadence': 'Cadence',
  'column.lastRun': 'Last run',
  'column.nextRun': 'Next run',
  'row.noSimpleForm': 'expression with no simple form',
  'row.zoneDrift': 'BullMQ still reads it in {zone}',
  'row.manualSuffix': ' · manual',
  'row.yourClock': '{clock} your time',
  'row.active': 'active',
  'row.disabled': 'disabled',
  'row.missingFromBullmq': 'missing from BullMQ — the worker reinstalls it at startup',
  'row.hideHistory': 'Hide',
  'row.showHistory': 'History',
  'row.editCadence': 'Cadence',
  'row.runNow': 'Run now',
  'history.empty': 'No run recorded.',
  'history.manual': 'triggered by hand',

  'notice.created': 'Job “{key}” scheduled',
  'notice.triggered': '“{key}” started',
  'notice.enabled': '“{key}” enabled',
  'notice.disabled': '“{key}” disabled',
  'notice.deleted': '“{key}” deleted',
  'notice.cadenceUpdated': 'Cadence of “{key}” changed',

  'dialog.title': 'Cadence of “{key}”',
  'dialog.expertOnly':
    'The saved expression has no simple form: the screen opens in expert mode rather than showing an approximate schedule.',

  'field.label': 'Cadence',
  'field.kind.label': 'Frequency',
  'field.mode.aria': 'Cadence entry mode',
  'field.mode.simple': 'Simple',
  'field.mode.expert': 'Expert',
  'field.timeZone.label': 'Time zone',
  'field.timeZone.unknown': '{zone} (unknown to this server)',
  'field.timeZone.irrelevant':
    'This cadence is an interval: it depends on no time zone. The setting is kept for the day it becomes a fixed hour.',
  'field.kind.interval': 'Every few minutes',
  'field.kind.hourly': 'Every hour',
  'field.kind.daily': 'Every day',
  'field.kind.weekly': 'Certain days of the week',
  'field.kind.monthly': 'Once a month',
  'field.interval.aria': 'Interval in minutes',
  'field.interval.option': 'every {minutes} min',
  'field.hourly.atMinute': 'at minute',
  'field.monthly.onDay': 'on day',
  'field.weekdays.aria': 'Days of the week',
  'field.time.at': 'at',
  'field.cron.aria': 'Cron expression',
  'field.expertNoSimple':
    'This expression has no simple form — ranges, hour steps or minute lists cannot be expressed there. Switching back to simple would replace it.',
  'field.shortMonths': 'Day {day} does not exist every month: the shorter ones are simply skipped.',

  'weekday.1.short': 'M',
  'weekday.1.long': 'Monday',
  'weekday.2.short': 'T',
  'weekday.2.long': 'Tuesday',
  'weekday.3.short': 'W',
  'weekday.3.long': 'Wednesday',
  'weekday.4.short': 'T',
  'weekday.4.long': 'Thursday',
  'weekday.5.short': 'F',
  'weekday.5.long': 'Friday',
  'weekday.6.short': 'S',
  'weekday.6.long': 'Saturday',
  'weekday.0.short': 'S',
  'weekday.0.long': 'Sunday',

  'preview.emptyCron': 'empty cadence',
  'preview.refused': 'Expression refused: {error}. Nothing is scheduled until it is valid.',
  'preview.computing': 'Next runs: computing…',
  'preview.noRun': 'No run in the next 366 days — check the expression.',
  'preview.next': 'Next',

  'help.trigger': 'What are scheduled jobs for?',
  'help.title': 'What are scheduled jobs for?',
  'help.subtitle':
    'What has to repeat without anyone clicking. They observe and alert — none of them acts on your deployments.',

  'help.idea.title': 'The guiding idea',
  'help.idea.p1':
    'A deployment is an event: you trigger it, it lands, you move on. But an image scanned clean three weeks ago may hold a vulnerability today, a running container may have died with no witness, and version directories pile up on the target until the disk fills. Scheduled jobs are what looks at all that at a regular interval.',
  'help.idea.p2.a': 'The common, non-negotiable rule: ',
  'help.idea.p2.strong': 'none of them acts',
  'help.idea.p2.b':
    '. A scan reporting a CRITICAL blocks nothing and redeploys nothing; a failing healthcheck triggers no rollback. The panel informs, the operator decides. The one exception is the version-directory purge, explicitly asked for, and it never touches the current version.',

  'help.types.title': 'What each type does',
  'help.types.column.type': 'Type',
  'help.types.column.what': 'What happens',
  'help.types.column.payload': 'Parameters (payload)',
  'help.types.default': 'default : ',

  'help.scan.steps.a': 'Walks the ',
  'help.scan.steps.current': 'current',
  'help.scan.steps.b':
    ' deployments, opens an SSH session on each target, asks the driver for the images in service, then runs the scanners configured for the application again. Reports ',
  'help.scan.steps.stack': 'stack up',
  'help.scan.steps.c':
    ' instead of replacing the previous ones: that is what lets you watch an unchanged image decay over the weeks.',
  'help.scan.payload.a': ' and ',
  'help.scan.payload.b': ' to force the configuration;',
  'help.scan.payload.c': ' / ',
  'help.scan.payload.d':
    ' to narrow the scope. With no scanner configured the application is skipped — the job imposes none.',

  'help.healthcheck.steps.a': 'Probes each current deployment through ',
  'help.healthcheck.steps.b': ' and writes the result (',
  'help.healthcheck.steps.c': ', ',
  'help.healthcheck.steps.d': ') into the deployment’s health history.',
  'help.healthcheck.payload.a': ' / ',
  'help.healthcheck.payload.b': ' only.',

  'help.cleanup.steps.a':
    'Asks each driver to purge its version directories on the target, beyond the ',
  'help.cleanup.steps.b':
    ' most recent. The job names no path and does not know which runtime it runs on: the driver knows where it drops its releases.',
  'help.cleanup.payload.a': ' (1 to 50, default 5); ',
  'help.cleanup.payload.b': ' / ',

  'help.preflight.steps.a': 'Sweeps the registered targets and ',
  'help.preflight.steps.queue': 'queues',
  'help.preflight.steps.b': ' one ',
  'help.preflight.steps.c':
    ' per target. It does not run preflight itself: it reuses the existing job, so that there is one implementation and one place where a credential is decrypted.',
  'help.preflight.payload': ' to refresh only part of the fleet.',
  'help.backup.steps.a':
    'For each application with automatic backup enabled, and each target it runs on, ',
  'help.backup.steps.queue': 'queues',
  'help.backup.steps.b': ' a backup on the ',
  'help.backup.steps.c':
    ' queue: export of recognized databases, archive of volumes, encrypted and stored on the destination. The details of each are on the application page.',
  'help.backup.payload.a': ' or ',
  'help.backup.payload.b': ' to back up only part of them.',
  'help.panel_backup.steps.a': 'Exports the Pupitre database with ',
  'help.panel_backup.steps.b':
    ', encrypts it and stores it on the destination. It does not contain ',
  'help.panel_backup.steps.c': ': keep that key elsewhere, without it no backup can be read.',
  'help.panel_backup.payload': 'No parameter.',

  'help.when.title': 'When they run',
  'help.when.a': 'The scheduler is ',
  'help.when.bullmq': 'BullMQ',
  'help.when.b': ', not a Linux cron: every active job is a Redis ',
  'help.when.scheduler': 'job scheduler',
  'help.when.c':
    ', and it is the one computing the next occurrence. The database stays the source of truth — at worker startup everything is reconciled: an active job missing from Redis is reinstalled there, a disabled or deleted job is removed. The ',
  'help.when.state': 'State',
  'help.when.d': ' column flags the drift when there is one.',

  'help.zone.title': 'The time zone, a setting of the job',
  'help.zone.p1.strong': 'Every job carries its own time zone',
  'help.zone.p1.a': ', saved next to its cron expression and passed to BullMQ as ',
  'help.zone.p1.b': '. A job set to “3 a.m.” in ',
  'help.zone.p1.c':
    ' really runs at 3 a.m. in Paris — and the matching UTC instant shifts with daylight saving, which is exactly the point. The time zone of the scheduling process no longer comes into play.',
  'help.zone.p2.a': 'A new job starts from ',
  'help.zone.p2.b':
    ', the instance time zone: the one you declared once already. The form’s selector lets you pick another, job by job — useful when a purge must land at night on a machine outside your zone. The preview under the field shows the time in the job’s zone, and on your own clock when the two differ.',
  'help.zone.legacy.a': 'Jobs older than this setting are in ',
  'help.zone.legacy.b':
    ' — not in {zone}. They were installed when the pattern went to BullMQ with no ',
  'help.zone.legacy.c':
    ' option, so it was read in the process time zone, which is UTC in our containers. Applying the instance zone to them would have moved their run by several hours with nobody asking. Change it explicitly if that is not what you wanted: the next occurrence is recomputed at once.',

  'help.modes.title': 'Simple or expert',
  'help.modes.p1':
    'Simple mode is only an entry aid: what gets saved stays a cron expression, the same one expert mode writes. So there is nothing to choose once and for all — a job created in simple mode reads back in expert mode, and the other way round when the expression has a simple form.',
  'help.modes.p2.a': 'Some expressions do not: ',
  'help.modes.p2.b':
    ' mixes a 7-minute step, an hour range and a day list. The screen then stays in expert mode and says so, rather than showing an approximate schedule that would be wrong. The sentence under the field always describes the real expression.',

  'help.actions.title': 'Run, disable, delete',
  'help.actions.run': 'Run now',
  'help.actions.run.a': ' queues an immediate occurrence, marked ',
  'help.actions.run.manual': 'manual',
  'help.actions.run.b':
    ' in the history. It runs even if the job is disabled — exactly what you want while setting a job up.',
  'help.actions.disable': 'Disable',
  'help.actions.disable.text':
    ' removes the scheduler from Redis but keeps the row, its history and its settings. An occurrence that arrives anyway is ignored: the worker re-reads the database before running.',
  'help.actions.delete': 'Delete',
  'help.actions.delete.text':
    ' removes the row and the scheduler. The action is traced in the logs, like the creation and every cadence change.',

  'help.cadence.title': 'Choosing the cadence',
  'help.cadence.column.job': 'Job',
  'help.cadence.column.value': 'Reasonable cadence',
  'help.cadence.column.why': 'Why',
  'help.cadence.healthcheck.job': 'Healthcheck',
  'help.cadence.healthcheck.value': 'every 5 to 15 minutes',
  'help.cadence.healthcheck.why.a':
    'Each occurrence opens one SSH session per deployment. Every minute, you exhaust ',
  'help.cadence.healthcheck.why.b': ' on the target and learn nothing more.',
  'help.cadence.scan.job': 'Periodic scan',
  'help.cadence.scan.value': 'once a night',
  'help.cadence.scan.why':
    'Vulnerability databases are updated daily at best. Scanning more often costs CPU on the target for the same report.',
  'help.cadence.cleanup.job': 'Version purge',
  'help.cadence.cleanup.value': 'once a night',
  'help.cadence.cleanup.why':
    'Offset from the scan, so the two do not run at the same time on the same machine.',
  'help.cadence.preflight.job': 'Target refresh',
  'help.cadence.preflight.value': 'every hour',
  'help.cadence.preflight.why':
    'A target does not change runtime four times an hour. An hour is enough to spot a machine gone unreachable.',

  'help.syntax.title': 'Cron syntax, for expert mode',
  'help.syntax.note.a': 'A sixth field, placed ',
  'help.syntax.note.before': 'in front',
  'help.syntax.note.b':
    ', means seconds. It is accepted but rarely useful: a job that needs the second is not a scheduled job.',
  'help.cheatsheet': `┌─ minute        0-59
│ ┌─ hour        0-23
│ │ ┌─ day       1-31   (of the month)
│ │ │ ┌─ month   1-12   or jan-dec
│ │ │ │ ┌─ day   0-7    (of the week, 0 and 7 = Sunday) or sun-sat
│ │ │ │ │
* * * * *

*        any value                 │  */15    a step: 0, 15, 30, 45
5        one value                 │  2-5     a range: 2, 3, 4, 5
1,3,5    a list                    │  2-8/2   a range with a step: 2, 4, 6, 8

*/15 * * * *     every 15 minutes
0 * * * *        every hour, on the hour
30 3 * * *       every day at 03:30
0 4 * * 1        every Monday at 04:00
0 4 * * 1-5      Monday to Friday at 04:00        (no simple form)
0 2 1 * *        on day 1 of every month at 02:00

Careful: day of month AND day of week set combine as OR.
“0 3 1 * 1” runs on the 1st of the month *and* every Monday.`,

  'error.keyTaken': 'A scheduled job “{key}” already exists',
  'error.notFound': 'No scheduled job “{id}”',
  'error.queueJobNotFound': 'No job “{id}” in the ops queue',
  'error.noJobId': 'The job got no ID',
};

export const jobs = { fr, en };
