import type { Translated } from '@pupitre/core';

/**
 * The monitored servers: the list per machine, the instant readings, the last 24
 * hours' history and the thresholds setting.
 *
 * ── Two sources, two vocabularies ───────────────────────────────────────────
 * A **measurement** comes from a probe, a **reading** comes from a machine sweep.
 * French already tells them apart, English keeps the distinction — *sample* and
 * *readout* — because both counters sometimes show in the same sentence and a
 * single word would make them unreadable.
 *
 * ── What stays literal ──────────────────────────────────────────────────────
 * `/proc/loadavg`, `MemAvailable`, `df`, `target:read`: they are file, field and
 * permission names. Translating them would send the reader looking for something
 * that does not exist on their machine.
 */
const fr = {
  // ── The screen's header ─────────────────────────────────────────────────
  'page.title': 'Supervision',
  'page.description':
    "Une carte par machine : comment elle se porte, et ce qu'elle porte. Les relevés se renouvellent toutes les 5 minutes, ou à la demande.",
  'page.empty': 'Aucun serveur à superviser',
  'page.empty.hint':
    'Déclarez une machine cible, puis déployez-y une application : les deux apparaîtront ici.',
  'page.empty.restricted':
    "Cet écran part du parc de machines, et le lire demande la permission target:read. Un administrateur peut l'ajouter à votre rôle depuis Administration → Rôles.",

  // ── Servers list ────────────────────────────────────────────────────────
  'list.servers': { one: '{count} serveur', other: '{count} serveurs' },
  'list.apps': {
    one: '{count} application supervisée',
    other: '{count} applications supervisées',
  },
  'list.probeAll': 'Tout relever',

  'list.filter.label': 'Filtrer les serveurs',
  'list.filter.all': 'Toutes',
  'list.filter.watch': 'À surveiller ({count})',
  'list.filter.none': 'Aucune machine à surveiller en ce moment.',
  'list.probeAll.toast': {
    one: 'Relevé lancé sur {count} machine',
    other: 'Relevé lancé sur {count} machines',
  },
  'list.probeAll.toast.detail': 'Les bandes se mettent à jour au fil des réponses.',
  'server.age': 'relevé {ago}',
  'server.probe.tip': 'Relever maintenant',
  'restart.dialog.title': 'Redémarrer {app} sur {target} ?',
  'restart.consequence.images':
    'Les conteneurs sont relancés avec les mêmes images et les mêmes volumes.',
  'restart.consequence.downtime': "L'application sera brièvement indisponible.",
  'restart.toast': 'Redémarrage de {app} enfilé',
  'thresholds.saved': 'Seuils de {name} enregistrés',
  'thresholds.saved.detail': 'Appliqués au prochain relevé.',

  'server.apps': {
    zero: 'aucune application',
    one: '{count} application',
    other: '{count} applications',
  },
  'server.noApps':
    'Aucune application supervisée sur cette machine. Déployez-en une depuis la page Applications : elle apparaîtra ici.',
  'server.details': 'Fiche',
  'status.unknown': 'jamais testée',
  'status.ok': 'opérationnelle',
  'status.degraded': 'dégradée',
  'status.unreachable': 'injoignable',

  'age.now': "à l'instant",
  'age.minutes': 'il y a {count} min',
  'age.hours': 'il y a {count} h',

  // ── A server's applications ─────────────────────────────────────────────
  'health.healthy': 'en marche',
  'health.unhealthy': 'répond mal',
  'health.unreachable': 'injoignable',
  'health.unknown': 'état inconnu',

  'column.application': 'Application',
  'column.uptime': 'En ligne depuis',

  'row.restored': 'version restaurée',
  'row.updateFailed': 'dernière mise à jour échouée',
  'row.failedStep': ' · étape {step}',
  'row.replaced': ' · les conteneurs ont pu être remplacés',

  'action.logs': 'Logs',
  'action.restart': 'Redémarrer',
  'action.restart.busy': 'Envoi…',
  /** A state's age, abbreviated: these units fit in a narrow column. */
  'since.none': '—',
  'since.seconds': '{count} s',
  'since.minutes': '{count} min',
  'since.hours': '{count} h',
  'since.days': '{count} j',

  // ── Instant reading ─────────────────────────────────────────────────────
  'readout.restricted':
    'Relevé indisponible — la permission « target:read » est requise pour interroger la machine.',
  'readout.pending': 'Relevé en cours…',
  'readout.failed': 'Relevé impossible — {message}',
  'readout.failed.http': 'Relevé impossible (HTTP {status})',
  'readout.unreachable':
    'Machine injoignable : {reason}. Les relevés reprendront au prochain balayage.',
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

  // ── History ─────────────────────────────────────────────────────────────
  'history.empty':
    'Aucun relevé en mémoire pour cette machine. Le balayage en écrit un toutes les 5 minutes ; le premier arrive dans la minute qui suit sa déclaration.',
  'history.samples': {
    one: '{count} relevé sur la fenêtre',
    other: '{count} relevés sur la fenêtre',
  },
  'history.unanswered': ' · {count} sans réponse',
  'history.toggle': 'Historique',
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

  'breach.line':
    '{metric} au-dessus de {limit} % {since} : {last} maintenant, {peak} au pire {samples}.',
  'breach.samples': { one: 'sur {count} relevé', other: 'sur {count} relevés' },
  'breach.since.minutes': 'depuis {count} min',
  'breach.since.hours': 'depuis {count} h',
  'breach.since.days': 'depuis {count} j',

  // ── Thresholds setting ──────────────────────────────────────────────────
  'thresholds.button': 'Seuils',
  'thresholds.aria': 'Régler les seuils de {name}',
  'thresholds.title': 'Seuils de {name}',
  'thresholds.description':
    "Au-delà du seuil, un dépassement s'ouvre et une seule entrée est écrite au journal, jusqu'au retour sous le seuil.",
  'thresholds.metric.load': 'Charge par cœur',
  'thresholds.hint.disk': 'partition qui porte les déploiements',
  'thresholds.hint.memory': 'utilisée = totale − disponible',
  'thresholds.hint.load': '100 % = un cœur plein par cœur',
  'thresholds.origin.default': 'livré avec le panel',
  'thresholds.origin.global': "seuil par défaut de l'instance",
  'thresholds.origin.target': 'propre à cette machine',
  'thresholds.watch.aria': 'Surveiller : {metric}',
  'thresholds.reset': 'rendre au défaut',
  'thresholds.invalid': '« {metric} » : un pourcentage entre 1 et 1000 est attendu.',
  'thresholds.refused': 'Enregistrement refusé (HTTP {status})',
  'thresholds.unreachable': 'Le panel est injoignable.',
} as const;

const en: Translated<typeof fr> = {
  'page.title': 'Servers',
  'page.description':
    'One card per machine: how it is doing, and what it carries. Readouts renew every 5 minutes, or on demand.',
  'page.empty': 'No server to monitor',
  'page.empty.hint': 'Declare a target host, then deploy an application on it: both show up here.',
  'page.empty.restricted':
    'This screen starts from the host fleet, and reading it takes the target:read permission. An administrator can add it to your role from Administration → Roles.',

  'list.servers': { one: '{count} server', other: '{count} servers' },
  'list.apps': {
    one: '{count} monitored application',
    other: '{count} monitored applications',
  },
  'list.probeAll': 'Read all',
  'list.filter.label': 'Filter servers',
  'list.filter.all': 'All',
  'list.filter.watch': 'To watch ({count})',
  'list.filter.none': 'No host to watch right now.',
  'list.probeAll.toast': {
    one: 'Readout started on {count} machine',
    other: 'Readout started on {count} machines',
  },
  'list.probeAll.toast.detail': 'Bands update as answers come in.',
  'server.age': 'read {ago}',
  'server.probe.tip': 'Read now',
  'restart.dialog.title': 'Restart {app} on {target}?',
  'restart.consequence.images': 'Containers restart with the same images and the same volumes.',
  'restart.consequence.downtime': 'The application will be briefly unavailable.',
  'restart.toast': 'Restart of {app} queued',
  'thresholds.saved': 'Thresholds of {name} saved',
  'thresholds.saved.detail': 'Applied at the next readout.',

  'server.apps': {
    zero: 'no application',
    one: '{count} application',
    other: '{count} applications',
  },
  'server.noApps':
    'No monitored application on this host. Deploy one from the Applications page: it shows up here.',
  'server.details': 'Details',
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

  'row.restored': 'version restored',
  'row.updateFailed': 'last update failed',
  'row.failedStep': ' · step {step}',
  'row.replaced': ' · containers may have been replaced',

  'action.logs': 'Logs',
  'action.restart': 'Restart',
  'action.restart.busy': 'Sending…',
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
  'readout.unreachable': 'Host unreachable: {reason}. Readouts resume at the next sweep.',
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
  'history.toggle': 'History',
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

  'breach.line': '{metric} above {limit}% {since}: {last} now, {peak} at worst {samples}.',
  'breach.samples': { one: 'over {count} readout', other: 'over {count} readouts' },
  'breach.since.minutes': 'for {count} min',
  'breach.since.hours': 'for {count} h',
  'breach.since.days': 'for {count} d',

  'thresholds.button': 'Thresholds',
  'thresholds.aria': 'Set the thresholds of {name}',
  'thresholds.title': 'Thresholds for {name}',
  'thresholds.description':
    'Past the threshold a breach opens and a single entry is written to the log, until the host drops back under it.',
  'thresholds.metric.load': 'Load per core',
  'thresholds.hint.disk': 'partition that carries the deployments',
  'thresholds.hint.memory': 'used = total − available',
  'thresholds.hint.load': '100% = one full core per core',
  'thresholds.origin.default': 'shipped with the panel',
  'thresholds.origin.global': 'instance default threshold',
  'thresholds.origin.target': 'set on this host',
  'thresholds.watch.aria': 'Watch: {metric}',
  'thresholds.reset': 'back to default',
  'thresholds.invalid': '“{metric}”: a percentage between 1 and 1000 is expected.',
  'thresholds.refused': 'Save refused (HTTP {status})',
  'thresholds.unreachable': 'The panel is unreachable.',
};

export const servers = { fr, en };
