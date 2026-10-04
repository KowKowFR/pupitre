import type { Translated } from '@pupitre/core';

/**
 * The operations station: the anomalies, the last 24 hours band, the inventory.
 *
 * ── What plurals change here ────────────────────────────────────────────────
 * It is the panel's screen that counts the most things, and almost all its
 * counters can be zero. French writes "0 cible prête", English *0 targets ready*:
 * the `${n > 1 ? 's' : ''}` that dotted this file would have produced neither.
 * Each count therefore goes through `{one, other}` and lets `Intl.PluralRules`
 * decide.
 *
 * ── What stays in French, and why ───────────────────────────────────────────
 * Nothing visible. The screen's only untranslated strings are the raw statuses
 * (`healthy`, `rolled_back`) shown as a last resort when the database returns a
 * value the catalog does not know: they are identifiers, not prose.
 */
const fr = {
  // ── Header ──────────────────────────────────────────────────────────────
  // An account without any permission: a sign-up waiting for its role.
  'noAccess.title': 'Votre compte n’a encore accès à rien',
  'noAccess.hint':
    'Un administrateur doit vous attribuer un rôle. Cette page s’ouvrira d’elle-même dès qu’il l’aura fait.',
  'page.title': "Vue d'ensemble",
  'page.deploy': 'Déployer',
  'window.label': "Fenêtre d'observation",
  'window.day': '24 h',
  'window.week': '7 j',
  'band.title.week': 'Les 7 derniers jours',
  'band.aside.week':
    'un intervalle toutes les 6 heures — chaque figure porte son nombre de mesures',
  'link.all': 'Tout voir',
  'fleet.aside': {
    one: '{count} cible, charge sur {window}',
    other: '{count} cibles, charge sur {window}',
  },
  'fleet.window.day': '24 h',
  'fleet.window.week': '7 jours',
  'fleet.apps': {
    one: '{count} application',
    other: '{count} applications',
  },
  'fleet.apps.none': 'aucune application',
  'fleet.runtime.unknown': 'runtime inconnu',
  'running.aside': '{shown} sur {total} affichées',

  'page.description':
    "Ce qui demande une intervention, ce qui s'est passé depuis hier, puis l'état du parc.",


  // ── Link labels to another section ──────────────────────────────────────
  'link.servers': 'Supervision',
  'link.targets': 'Cibles',
  'link.applications': 'Applications',
  'link.monitors': 'Sondes',
  'link.history': 'Historique',

  // ── What requires attention ─────────────────────────────────────────────
  'attention.title': {
    one: '{count} point demande votre attention',
    other: '{count} points demandent votre attention',
  },
  'attention.aside': "Le reste de l'instance se porte bien.",
  'attention.maintenance': ' En maintenance : ses alertes sont retenues.',
  'forecast.title': {
    one: '{count} problème en vue',
    other: '{count} problèmes en vue',
  },
  'forecast.aside': 'Prévisions sur les relevés gardés, recalculées toutes les 30 minutes.',
  'forecast.open': 'Voir',
  'attention.clear': "Rien ne demande d'intervention.",
  'attention.clear.detail':
    'Les cibles répondent, les applications tournent, les sondes sont au vert.',

  'attention.target.unreachable':
    "Machine injoignable — {host}. Les applications qu'elle porte ne peuvent plus être ni supervisées, ni mises à jour.",
  'attention.target.degraded':
    'Preflight dégradé sur {host}. Un déploiement peut échouer sans que la cause soit visible.',
  'attention.app.unreachable': "L'application ne répond plus à sa sonde de santé.",
  'attention.app.unhealthy': 'La sonde de santé répond, mais pas comme attendu.',
  'attention.app.failed': "La mise à jour en v{version} a échoué à l'étape « {step} ». ",
  'attention.app.failed.unknownStep': 'inconnue',
  'attention.app.failed.replaced':
    'Elle avait commencé à remplacer les conteneurs : vérifiez ce qui tourne.',
  'attention.app.failed.kept': 'La version précédente tourne toujours.',
  'attention.monitor.unreachable': 'La sonde ne joint plus sa cible depuis le panel.',
  'attention.monitor.unhealthy':
    'La sonde joint sa cible, mais la réponse ne correspond pas à ce qui est attendu.',
  'attention.deployment.failed': 'Déploiement échoué sur {target}{step}.',
  'attention.deployment.atStep': " à l'étape « {step} »",
  'attention.deployment.rolledBack':
    'Déploiement replié sur {target}{step}. La version précédente a été remise en place automatiquement.',
  'attention.deployment.refused': " — l'étape « {step} » a refusé la version",
  'attention.scans.subject': 'Analyses de sécurité',
  'attention.scans.lead': {
    one: '{count} analyse a conclu « conforme » tout en rapportant',
    other: '{count} analyses ont conclu « conforme » tout en rapportant',
  },
  'attention.scans.critical': {
    one: '{count} faille critique',
    other: '{count} failles critiques',
  },
  'attention.scans.fixable': {
    one: '(dont {count} corrigeable)',
    other: '(dont {count} corrigeables)',
  },
  'attention.scans.tail':
    'et {high} de gravité haute. Le seuil de blocage est sur « aucun » : le verdict ne bloque rien.',

  'attention.action.diagnose': 'Diagnostiquer',
  'attention.action.logs': 'Voir les logs',
  'attention.action.trace': 'Voir la trace',
  'attention.action.monitor': 'Voir la sonde',
  'attention.action.threshold': 'Régler le seuil',

  // ── The last 24 hours band ──────────────────────────────────────────────
  'band.title': 'Les dernières 24 heures',
  'band.aside': 'un intervalle par heure, chaque figure indique son nombre de mesures',
  'band.locked': "Aucune des séries de cet écran n'est accessible avec vos permissions.",

  /**
   * The decimal separator. A `.toFixed()` always returns a point; French writes a
   * comma. It is the only substitution of this kind in the file, and it is better
   * than a `toLocaleString` that would also reformat the thousands.
   */
  'band.decimal': ',',

  'band.availability': 'Disponibilité',
  'band.availability.none': 'aucune mesure de sonde',
  'band.availability.thin': 'mesures saines — trop peu pour un taux',
  'band.availability.over': 'sur {count} mesures',
  'band.latency': 'Latence médiane',
  'band.latency.none': 'moins de 3 intervalles mesurés',
  'band.latency.over': 'médiane des moyennes horaires',
  'band.load': 'Charge maximale',
  'band.load.none': 'aucun relevé machine',
  'band.load.over': 'pire machine du parc · {covered}/{buckets} h couvertes',
  'band.denied': "Refus d'accès",
  'band.denied.over': 'sur {count} actions journalisées',

  'lane.monitor.title': 'Disponibilité des sondes',
  'lane.monitor.aside': 'en % de mesures saines',
  'lane.monitor.aside.active': {
    one: 'en % de mesures saines · {count} sonde active',
    other: 'en % de mesures saines · {count} sondes actives',
  },
  'lane.monitor.unit': 'sain',
  'lane.monitor.nothing': 'Aucune mesure de sonde',
  'lane.monitor.help':
    "Les sondes tournent par tâche planifiée. Vérifiez qu'au moins une sonde est active sur",


  'lane.latency.title': 'Latence des sondes',
  'lane.latency.aside': 'en millisecondes, moyenne par heure',
  'lane.latency.nothing': 'Aucun temps de réponse',

  'lane.fleet.title': 'Charge du parc',
  'lane.fleet.aside': 'en %, pire machine — plafond {limit} %',
  'lane.fleet.series': 'Charge maximale du parc',
  'lane.fleet.nothing': 'Aucun relevé machine',
  'lane.fleet.help':
    "Le balayage des machines écrit un relevé toutes les cinq minutes. S'il n'y en a aucun, la tâche planifiée ne tourne pas.",
  'lane.fleet.sparse':
    "Trop peu d'heures couvertes pour parler de tendance — la collecte vient de commencer.",

  'lane.chronicle.title': 'Déploiements',
  'chronicle.event': '{app} v{version} sur {target} — {status}',
  'chronicle.event.step': ' · étape « {step} »',
  'chronicle.empty': 'Aucun déploiement dans les 24 dernières heures.',
  'chronicle.empty.none': 'Aucun non plus sur les {days} derniers jours.',
  'chronicle.empty.older': {
    one: "{count} plus ancien sur {days} jours — voir l'historique.",
    other: "{count} plus anciens sur {days} jours — voir l'historique.",
  },
  'chronicle.inWindow': '{count} dans la fenêtre',
  'chronicle.offAxis': {
    one: ' · {count} plus ancien hors axe',
    other: ' · {count} plus anciens hors axe',
  },
  'chronicle.median.none': ' · durée médiane indisponible sous 3 pipelines',
  'chronicle.median.value': ' · durée médiane {seconds} s',
  'chronicle.scans': ' · {count} analyses de sécurité',

  // ── Statuts ─────────────────────────────────────────────────────────────
  'status.success': 'réussi',
  'status.failed': 'échoué',
  'status.rolled_back': 'replié',
  'status.destroyed': 'retiré',
  'status.running': 'en cours',
  'status.pending': 'en attente',

  'health.healthy': 'en marche',
  'health.unhealthy': 'répond mal',
  'health.unreachable': 'injoignable',
  'health.unknown': 'état inconnu',

  // ── Le parc ─────────────────────────────────────────────────────────────
  'fleet.title': 'Machines',
  'fleet.empty': 'Aucune machine cible déclarée. Ajoutez-en une depuis',
  'fleet.gauge.memory': 'mém',
  'fleet.gauge.disk': 'dsk',
  'fleet.noReadout': 'aucun relevé sur 24 h',

  // ── What runs ───────────────────────────────────────────────────────────
  'running.title': 'En marche',
  'running.empty': 'Aucune application en marche. Déployez-en une depuis',

  // ── The last deployments ────────────────────────────────────────────────
  'deployments.title': 'Derniers déploiements',
  'deployments.empty': "Aucun déploiement pour l'instant.",
  'deployments.weakness': "Sur {days} jours, l'étape qui casse est",
  'deployments.weakness.name': '« {name} »',
  'deployments.weakness.count': {
    one: '({failed} échec sur {decided})',
    other: '({failed} échecs sur {decided})',
  },

  // ── The inventory, at the bottom of the screen ──────────────────────────
  'readout.targets': 'Cibles prêtes',
  'readout.targets.faulty': '{count} en défaut',
  'readout.targets.untested': {
    one: '{count} jamais testée',
    other: '{count} jamais testées',
  },
  'readout.targets.ok': 'preflight au vert',
  'readout.apps': 'Applications en marche',
  'readout.apps.declared': {
    one: '{count} déclarée',
    other: '{count} déclarées',
  },
  'readout.monitors': 'Sondes au vert',
  'readout.monitors.hint': 'supervision de sites',
  'readout.inFlight': 'En vol',
  'readout.inFlight.off': 'aucun déploiement en cours',

  // ── An event's age ──────────────────────────────────────────────────────
  'duration.seconds': '{seconds} s',
  'duration.minutes': '{minutes} min {seconds} s',
  'since.seconds': 'il y a {count} s',
  'since.minutes': 'il y a {count} min',
  'since.hours': 'il y a {count} h',
  'since.days': 'il y a {count} j',
} as const;

const en: Translated<typeof fr> = {
  'noAccess.title': 'Your account has no access yet',
  'noAccess.hint':
    'An administrator has to assign you a role. This page will open by itself as soon as they do.',
  'page.title': 'Overview',
  'page.deploy': 'Deploy',
  'window.label': 'Observation window',
  'window.day': '24 h',
  'window.week': '7 d',
  'band.title.week': 'The last 7 days',
  'band.aside.week': 'one interval every 6 hours — each figure carries its sample count',
  'link.all': 'See all',
  'fleet.aside': {
    one: '{count} target, load over {window}',
    other: '{count} targets, load over {window}',
  },
  'fleet.window.day': '24 h',
  'fleet.window.week': '7 days',
  'fleet.apps': {
    one: '{count} application',
    other: '{count} applications',
  },
  'fleet.apps.none': 'no application',
  'fleet.runtime.unknown': 'unknown runtime',
  'running.aside': '{shown} of {total} shown',

  'page.description':
    'What needs action, what happened since yesterday, then the state of the fleet.',


  'link.servers': 'Servers',
  'link.targets': 'Targets',
  'link.applications': 'Applications',
  'link.monitors': 'Monitoring',
  'link.history': 'History',

  'attention.title': {
    one: '{count} item needs your attention',
    other: '{count} items need your attention',
  },
  'attention.aside': 'The rest of the instance is fine.',
  'attention.maintenance': ' In maintenance: its alerts are held.',
  'forecast.title': {
    one: '{count} problem ahead',
    other: '{count} problems ahead',
  },
  'forecast.aside': 'Forecasts from the kept readings, recalculated every 30 minutes.',
  'forecast.open': 'View',
  'attention.clear': 'Nothing needs action.',
  'attention.clear.detail': 'Targets answer, applications run, probes are green.',

  'attention.target.unreachable':
    'Host unreachable — {host}. The applications it carries can no longer be monitored or updated.',
  'attention.target.degraded':
    'Preflight degraded on {host}. A deployment can fail without the cause being visible.',
  'attention.app.unreachable': 'The application no longer answers its health check.',
  'attention.app.unhealthy': 'The health check answers, but not as expected.',
  'attention.app.failed': 'The update to v{version} failed at step “{step}”. ',
  'attention.app.failed.unknownStep': 'unknown',
  'attention.app.failed.replaced':
    'It had started replacing the containers: check what is running.',
  'attention.app.failed.kept': 'The previous version is still running.',
  'attention.monitor.unreachable': 'The probe no longer reaches its target from the panel.',
  'attention.monitor.unhealthy':
    'The probe reaches its target, but the answer is not the expected one.',
  'attention.deployment.failed': 'Deployment failed on {target}{step}.',
  'attention.deployment.atStep': ' at step “{step}”',
  'attention.deployment.rolledBack':
    'Deployment rolled back on {target}{step}. The previous version was put back automatically.',
  'attention.deployment.refused': ' — step “{step}” refused the version',
  'attention.scans.subject': 'Security scans',
  'attention.scans.lead': {
    one: '{count} scan concluded “compliant” while reporting',
    other: '{count} scans concluded “compliant” while reporting',
  },
  'attention.scans.critical': {
    one: '{count} critical finding',
    other: '{count} critical findings',
  },
  'attention.scans.fixable': {
    one: '({count} of them fixable)',
    other: '({count} of them fixable)',
  },
  'attention.scans.tail':
    'and {high} of high severity. The blocking threshold is set to “none”: the verdict blocks nothing.',

  'attention.action.diagnose': 'Diagnose',
  'attention.action.logs': 'View logs',
  'attention.action.trace': 'View the trace',
  'attention.action.monitor': 'View the probe',
  'attention.action.threshold': 'Set the threshold',

  'band.title': 'The last 24 hours',
  'band.aside': 'one interval per hour — every figure carries its sample count',
  'band.locked': 'None of this screen’s series is available with your permissions.',

  'band.decimal': '.',

  'band.availability': 'Availability',
  'band.availability.none': 'no probe sample',
  'band.availability.thin': 'healthy samples — too few for a rate',
  'band.availability.over': 'over {count} samples',
  'band.latency': 'Median latency',
  'band.latency.none': 'fewer than 3 intervals measured',
  'band.latency.over': 'median of the hourly averages',
  'band.load': 'Peak load',
  'band.load.none': 'no host readout',
  'band.load.over': 'worst host in the fleet · {covered}/{buckets} h covered',
  'band.denied': 'Access denials',
  'band.denied.over': 'over {count} logged actions',

  'lane.monitor.title': 'Probe availability',
  'lane.monitor.aside': 'in % of healthy samples',
  'lane.monitor.aside.active': {
    one: 'in % of healthy samples · {count} active probe',
    other: 'in % of healthy samples · {count} active probes',
  },
  'lane.monitor.unit': 'healthy',
  'lane.monitor.nothing': 'No probe sample',
  'lane.monitor.help':
    'Probes run from a scheduled job. Check that at least one probe is active in',


  'lane.latency.title': 'Probe latency',
  'lane.latency.aside': 'in milliseconds, hourly average',
  'lane.latency.nothing': 'No response time',

  'lane.fleet.title': 'Fleet load',
  'lane.fleet.aside': 'in %, worst host — ceiling {limit}%',
  'lane.fleet.series': 'Peak fleet load',
  'lane.fleet.nothing': 'No host readout',
  'lane.fleet.help':
    'The host sweep writes a readout every five minutes. If there is none, the scheduled job is not running.',
  'lane.fleet.sparse':
    'Too few hours covered to call it a trend — collection has only just started.',

  'lane.chronicle.title': 'Deployments',
  'chronicle.event': '{app} v{version} on {target} — {status}',
  'chronicle.event.step': ' · step “{step}”',
  'chronicle.empty': 'No deployment in the last 24 hours.',
  'chronicle.empty.none': 'None over the last {days} days either.',
  'chronicle.empty.older': {
    one: '{count} older over {days} days — see the history.',
    other: '{count} older over {days} days — see the history.',
  },
  'chronicle.inWindow': '{count} in the window',
  'chronicle.offAxis': {
    one: ' · {count} older off axis',
    other: ' · {count} older off axis',
  },
  'chronicle.median.none': ' · median duration needs 3 pipelines',
  'chronicle.median.value': ' · median duration {seconds} s',
  'chronicle.scans': ' · {count} security scans',

  'status.success': 'succeeded',
  'status.failed': 'failed',
  'status.rolled_back': 'rolled back',
  'status.destroyed': 'removed',
  'status.running': 'running',
  'status.pending': 'pending',

  'health.healthy': 'running',
  'health.unhealthy': 'answers badly',
  'health.unreachable': 'unreachable',
  'health.unknown': 'state unknown',

  'fleet.title': 'Hosts',
  'fleet.empty': 'No target host declared. Add one from',
  'fleet.gauge.memory': 'mem',
  'fleet.gauge.disk': 'dsk',
  'fleet.noReadout': 'no readout over 24 h',

  'running.title': 'Running',
  'running.empty': 'No application running. Deploy one from',

  'deployments.title': 'Latest deployments',
  'deployments.empty': 'No deployment yet.',
  'deployments.weakness': 'Over {days} days, the step that breaks is',
  'deployments.weakness.name': '“{name}”',
  'deployments.weakness.count': {
    one: '({failed} failure out of {decided})',
    other: '({failed} failures out of {decided})',
  },

  'readout.targets': 'Targets ready',
  'readout.targets.faulty': '{count} faulty',
  'readout.targets.untested': {
    one: '{count} never tested',
    other: '{count} never tested',
  },
  'readout.targets.ok': 'preflight green',
  'readout.apps': 'Applications running',
  'readout.apps.declared': {
    one: '{count} declared',
    other: '{count} declared',
  },
  'readout.monitors': 'Probes green',
  'readout.monitors.hint': 'site monitoring',
  'readout.inFlight': 'In flight',
  'readout.inFlight.off': 'no deployment under way',

  'duration.seconds': '{seconds} s',
  'duration.minutes': '{minutes} min {seconds} s',
  'since.seconds': '{count} s ago',
  'since.minutes': '{count} min ago',
  'since.hours': '{count} h ago',
  'since.days': '{count} d ago',
};

export const dashboard = { fr, en };
