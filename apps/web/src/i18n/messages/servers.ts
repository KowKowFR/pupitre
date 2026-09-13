import type { Translated } from '@pupitre/core';

/**
 * Les serveurs supervisés : la liste par machine, les relevés instantanés,
 * l'historique des dernières 24 heures et le réglage des seuils.
 *
 * ── Deux sources, deux vocabulaires ─────────────────────────────────────────
 * Une **mesure** vient d'une sonde, un **relevé** vient d'un balayage de
 * machine. Le français les distingue déjà, l'anglais garde la distinction —
 * *sample* et *readout* — parce que les deux compteurs s'affichent parfois dans
 * la même phrase et qu'un seul mot les rendrait illisibles.
 *
 * ── Ce qui reste littéral ───────────────────────────────────────────────────
 * `/proc/loadavg`, `MemAvailable`, `df`, `target:read` : ce sont des noms de
 * fichiers, de champs et de permissions. Les traduire enverrait le lecteur
 * chercher quelque chose qui n'existe pas sur sa machine.
 */
const fr = {
  // ── En-tête de l'écran ──────────────────────────────────────────────────
  'page.eyebrow': 'Supervision',
  'page.title': 'Serveurs et applications',
  'page.description':
    "Une ligne par machine : comment elle se porte, et ce qu'elle porte. Dépliez un serveur pour voir ses applications. Une application dont la dernière mise à jour a échoué reste listée — elle tourne toujours, dans sa version précédente. L'historique des déploiements est ailleurs.",
  'page.empty': 'Aucun serveur à superviser',
  'page.empty.hint':
    'Déclarez une machine cible, puis déployez-y une application : les deux apparaîtront ici.',
  'page.empty.restricted':
    "Cet écran part du parc de machines, et le lire demande la permission target:read. Un administrateur peut l'ajouter à votre rôle depuis Administration → Rôles.",

  // ── Liste des serveurs ──────────────────────────────────────────────────
  'list.servers': { one: '{count} serveur', other: '{count} serveurs' },
  /**
   * Le français écrivait déjà « application(s) supervisée(s) » avec ses
   * parenthèses : on le reproduit tel quel, c'est la chaîne que cherchent les
   * vérifications d'intégration. L'anglais, lui, n'a aucune raison de garder
   * cette béquille et accorde pour de bon.
   */
  'list.apps': {
    one: '{count} application(s) supervisée(s)',
    other: '{count} application(s) supervisée(s)',
  },
  'list.probeAll': 'Tout relever',

  'server.apps': {
    zero: 'aucune application',
    one: '{count} application',
    other: '{count} applications',
  },
  'server.noApps':
    'Aucune application supervisée sur cette machine. Déployez-en une depuis la page Applications : elle apparaîtra ici.',
  'server.details': 'Fiche',
  'server.probe': 'Relever',
  'server.probe.busy': 'Relevé…',
  'server.probe.aria': 'Relever les métriques de {name}',

  'status.unknown': 'jamais testée',
  'status.ok': 'opérationnelle',
  'status.degraded': 'dégradée',
  'status.unreachable': 'injoignable',

  'age.now': "à l'instant",
  'age.minutes': 'il y a {count} min',
  'age.hours': 'il y a {count} h',

  // ── Applications d'un serveur ───────────────────────────────────────────
  'health.healthy': 'en marche',
  'health.unhealthy': 'répond mal',
  'health.unreachable': 'injoignable',
  'health.unknown': 'état inconnu',

  'column.application': 'Application',
  'column.uptime': 'En ligne depuis',
  'column.address': 'Adresse',

  'row.services': { one: '{count} service', other: '{count} services' },
  'row.restored': 'version restaurée',
  'row.updateFailed': 'dernière mise à jour échouée',
  'row.failedStep': ' · étape {step}',
  'row.replaced': ' · les conteneurs ont pu être remplacés',

  'action.logs': 'Logs',
  'action.restart': 'Redémarrer',
  'action.restart.busy': 'Envoi…',
  'restart.confirm': 'Redémarrer « {app} » sur {target} ?',
  'restart.confirm.detail':
    "Les conteneurs sont relancés avec les mêmes images et les mêmes volumes. L'application sera brièvement indisponible.",

  /** Âge d'un état, en abrégé : ces unités tiennent dans une colonne étroite. */
  'since.none': '—',
  'since.seconds': '{count} s',
  'since.minutes': '{count} min',
  'since.hours': '{count} h',
  'since.days': '{count} j',

  // ── Relevé instantané ───────────────────────────────────────────────────
  'readout.restricted':
    'Relevé indisponible — la permission « target:read » est requise pour interroger la machine.',
  'readout.pending': 'Relevé en cours…',
  'readout.failed': 'Relevé impossible — {message}',
  'readout.failed.http': 'Relevé impossible (HTTP {status})',
  'readout.unreachable': 'Machine injoignable — {reason}',
  'readout.unreachable.reason': 'raison inconnue',
  'panel.unreachable': 'Le panel est injoignable',

  unknown: 'inconnu',
  percent: '{value} %',

  'metric.load': 'Charge',
  'metric.memory': 'Mémoire',
  'metric.disk': 'Disque',
  'metric.uptime': 'Uptime',

  'load.noSource': 'aucun /proc/loadavg',
  'load.noCores': '{five} · {fifteen} — cœurs inconnus',
  'load.perCore': {
    one: '{percent} % de {count} cœur',
    other: '{percent} % de {count} cœurs',
  },
  'memory.noSource': 'aucun MemAvailable',
  'memory.used': '{used} / {total} Gio utilisés',
  'disk.noSource': 'aucun df exploitable',
  'disk.free': '{free} Gio libres · {path}',
  'os.unknown': 'système inconnu',

  'uptime.days': '{days} j {hours} h',
  'uptime.hours': '{hours} h {minutes} min',
  'uptime.minutes': '{minutes} min',

  // ── Historique ──────────────────────────────────────────────────────────
  'history.empty':
    'Aucun relevé en mémoire pour cette machine. Le balayage en écrit un toutes les 5 minutes ; le premier arrive dans la minute qui suit sa déclaration.',
  'history.samples': {
    one: '{count} relevé sur la fenêtre',
    other: '{count} relevés sur la fenêtre',
  },
  'history.unanswered': ' · {count} sans réponse',
  'history.window': "Fenêtre d'historique",
  'history.window.24h': '24 h',
  'history.window.7d': '7 j',

  'spark.aria': '{metric} : {count} intervalles, du plus ancien au plus récent',
  'spark.empty': '{clock} — aucune mesure',
  'spark.point': '{clock} — {value}{over}',
  'spark.over': ' (au-dessus de {limit} %)',
  'spark.limit': 'seuil : {limit} %',

  'trend.stable': 'stable',
  'trend.points': '{value} pt',

  'metric.worst': 'pire',
  'threshold.value': 'seuil {value}',
  'threshold.off': 'sans seuil',
  'threshold.from.target': 'seuil propre à cette machine',
  'threshold.from.global': "seuil par défaut de l'instance",
  'threshold.from.default': 'seuil livré avec le panel',

  'breach.over': 'au-dessus de {limit} % {since} —',
  'breach.values': '{last} maintenant, {peak} au pire',
  'breach.samples': { one: '({count} relevé)', other: '({count} relevés)' },
  'breach.since.minutes': 'depuis {count} min',
  'breach.since.hours': 'depuis {count} h',
  'breach.since.days': 'depuis {count} j',

  // ── Réglage des seuils ──────────────────────────────────────────────────
  'thresholds.button': 'Seuils',
  'thresholds.aria': 'Régler les seuils de {name}',
  'thresholds.title': 'Seuils de {name}',
  'thresholds.description':
    "Au-delà du seuil, un dépassement s'ouvre et une entrée est écrite au journal d'activité —",
  'thresholds.description.once': 'une seule',
  'thresholds.description.end':
    ', au franchissement, pas une par relevé. Elle se referme quand la machine repasse sous le seuil.',
  'thresholds.metric.load': 'Charge par cœur',
  'thresholds.hint.disk': 'partition qui porte les déploiements',
  'thresholds.hint.memory': 'utilisée = totale − disponible',
  'thresholds.hint.load': '100 % = un cœur plein par cœur',
  'thresholds.origin.default': 'valeur livrée avec le panel',
  'thresholds.origin.global': "défaut de l'instance",
  'thresholds.origin.target': 'propre à cette machine',
  'thresholds.watch': 'Surveiller cette métrique',
  'thresholds.reset': 'rendre au défaut',
  'thresholds.invalid': '« {metric} » : un pourcentage entre 1 et 1000 est attendu.',
  'thresholds.refused': 'Enregistrement refusé (HTTP {status})',
  'thresholds.unreachable': 'Le panel est injoignable.',
} as const;

const en: Translated<typeof fr> = {
  'page.eyebrow': 'Servers',
  'page.title': 'Servers and applications',
  'page.description':
    'One line per host: how it is doing, and what it carries. Expand a server to see its applications. An application whose last update failed stays listed — it is still running, in its previous version. Deployment history lives elsewhere.',
  'page.empty': 'No server to monitor',
  'page.empty.hint':
    'Declare a target host, then deploy an application on it: both show up here.',
  'page.empty.restricted':
    'This screen starts from the host fleet, and reading it takes the target:read permission. An administrator can add it to your role from Administration → Roles.',

  'list.servers': { one: '{count} server', other: '{count} servers' },
  'list.apps': {
    one: '{count} monitored application',
    other: '{count} monitored applications',
  },
  'list.probeAll': 'Read all',

  'server.apps': {
    zero: 'no application',
    one: '{count} application',
    other: '{count} applications',
  },
  'server.noApps':
    'No monitored application on this host. Deploy one from the Applications page: it shows up here.',
  'server.details': 'Details',
  'server.probe': 'Read',
  'server.probe.busy': 'Reading…',
  'server.probe.aria': 'Read the metrics of {name}',

  'status.unknown': 'never tested',
  'status.ok': 'operational',
  'status.degraded': 'degraded',
  'status.unreachable': 'unreachable',

  'age.now': 'just now',
  'age.minutes': '{count} min ago',
  'age.hours': '{count} h ago',

  'health.healthy': 'running',
  'health.unhealthy': 'answers badly',
  'health.unreachable': 'unreachable',
  'health.unknown': 'state unknown',

  'column.application': 'Application',
  'column.uptime': 'Live since',
  'column.address': 'Address',

  'row.services': { one: '{count} service', other: '{count} services' },
  'row.restored': 'version restored',
  'row.updateFailed': 'last update failed',
  'row.failedStep': ' · step {step}',
  'row.replaced': ' · containers may have been replaced',

  'action.logs': 'Logs',
  'action.restart': 'Restart',
  'action.restart.busy': 'Sending…',
  'restart.confirm': 'Restart “{app}” on {target}?',
  'restart.confirm.detail':
    'Containers are relaunched with the same images and the same volumes. The application will be briefly unavailable.',

  'since.none': '—',
  'since.seconds': '{count} s',
  'since.minutes': '{count} min',
  'since.hours': '{count} h',
  'since.days': '{count} d',

  'readout.restricted':
    'Readout unavailable — the “target:read” permission is required to query the host.',
  'readout.pending': 'Reading…',
  'readout.failed': 'Readout failed — {message}',
  'readout.failed.http': 'Readout failed (HTTP {status})',
  'readout.unreachable': 'Host unreachable — {reason}',
  'readout.unreachable.reason': 'reason unknown',
  'panel.unreachable': 'The panel is unreachable',

  unknown: 'unknown',
  percent: '{value}%',

  'metric.load': 'Load',
  'metric.memory': 'Memory',
  'metric.disk': 'Disk',
  'metric.uptime': 'Uptime',

  'load.noSource': 'no /proc/loadavg',
  'load.noCores': '{five} · {fifteen} — cores unknown',
  'load.perCore': {
    one: '{percent}% of {count} core',
    other: '{percent}% of {count} cores',
  },
  'memory.noSource': 'no MemAvailable',
  'memory.used': '{used} / {total} GiB used',
  'disk.noSource': 'no usable df',
  'disk.free': '{free} GiB free · {path}',
  'os.unknown': 'system unknown',

  'uptime.days': '{days} d {hours} h',
  'uptime.hours': '{hours} h {minutes} min',
  'uptime.minutes': '{minutes} min',

  'history.empty':
    'No readout kept for this host. The sweep writes one every 5 minutes; the first lands within a minute of the host being declared.',
  'history.samples': {
    one: '{count} readout over the window',
    other: '{count} readouts over the window',
  },
  'history.unanswered': ' · {count} with no answer',
  'history.window': 'History window',
  'history.window.24h': '24 h',
  'history.window.7d': '7 d',

  'spark.aria': '{metric}: {count} intervals, oldest to newest',
  'spark.empty': '{clock} — no sample',
  'spark.point': '{clock} — {value}{over}',
  'spark.over': ' (above {limit}%)',
  'spark.limit': 'threshold: {limit}%',

  'trend.stable': 'stable',
  'trend.points': '{value} pt',

  'metric.worst': 'worst',
  'threshold.value': 'threshold {value}',
  'threshold.off': 'no threshold',
  'threshold.from.target': 'threshold set on this host',
  'threshold.from.global': 'instance default threshold',
  'threshold.from.default': 'threshold shipped with the panel',

  'breach.over': 'above {limit}% {since} —',
  'breach.values': '{last} now, {peak} at worst',
  'breach.samples': { one: '({count} readout)', other: '({count} readouts)' },
  'breach.since.minutes': 'for {count} min',
  'breach.since.hours': 'for {count} h',
  'breach.since.days': 'for {count} d',

  'thresholds.button': 'Thresholds',
  'thresholds.aria': 'Set the thresholds of {name}',
  'thresholds.title': 'Thresholds for {name}',
  'thresholds.description':
    'Past the threshold a breach opens and one line is written to the activity log —',
  'thresholds.description.once': 'one only',
  'thresholds.description.end':
    ', at the crossing, not one per readout. It closes when the host drops back under the threshold.',
  'thresholds.metric.load': 'Load per core',
  'thresholds.hint.disk': 'partition that carries the deployments',
  'thresholds.hint.memory': 'used = total − available',
  'thresholds.hint.load': '100% = one full core per core',
  'thresholds.origin.default': 'value shipped with the panel',
  'thresholds.origin.global': 'instance default',
  'thresholds.origin.target': 'set on this host',
  'thresholds.watch': 'Watch this metric',
  'thresholds.reset': 'back to default',
  'thresholds.invalid': '“{metric}”: a percentage between 1 and 1000 is expected.',
  'thresholds.refused': 'Save refused (HTTP {status})',
  'thresholds.unreachable': 'The panel is unreachable.',
};

export const servers = { fr, en };
