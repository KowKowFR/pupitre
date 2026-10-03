import type { Translated } from '@pupitre/core';

/**
 * La supervision de sites — la liste des sondes, le détail de l'une d'elles,
 * ses figures et ses captures d'incident.
 *
 * Le catalogue des types de sonde n'est **pas** ici : il vit dans
 * `packages/core/src/monitors/catalog.ts`, avec sa propre paire fr/en, parce
 * que le worker lit la même table. Ce module ne porte que ce que le panel
 * écrit lui-même autour.
 *
 * Deux pluriels français sont volontairement identiques au singulier et au
 * pluriel : « {count} échec sur {threshold} » et « {count} mesures ». Ils
 * reproduisent la chaîne qui existait, y compris son accord approximatif ; la
 * forme anglaise, elle, accorde. Corriger le français est un autre commit.
 */
const fr = {
  // ── En-tête de l'écran ──────────────────────────────────────────────────
  'page.title': 'Sondes',
  'page.description':
    "Une sonde part du worker vers l'adresse publique d'un service. Elle voit ce que le healthcheck SSH ne voit pas : le pare-feu, le proxy, le certificat.",

  // ── Verdicts d'une mesure ───────────────────────────────────────────────
  'outcome.healthy': 'sain',
  'outcome.unhealthy': 'répond mal',
  'outcome.unreachable': 'injoignable',
  'outcome.unknown': 'inconnu',

  /**
   * Le voyant `HealthDot` porte son propre vocabulaire, celui de l'écran des
   * applications : « en marche » plutôt que « sain ». On le reprend mot pour
   * mot au lieu d'imposer le nôtre — un seul voyant, une seule lecture.
   */
  'health.healthy': 'en marche',
  'health.unhealthy': 'répond mal',
  'health.unreachable': 'injoignable',
  'health.unknown': 'état inconnu',

  // ── Liste ───────────────────────────────────────────────────────────────
  'empty.title': 'Aucune sonde',
  'empty.hint.canManage':
    "Une sonde part du worker vers l'adresse publique de ce qu'elle surveille. C'est un point de vue différent du healthcheck : elle voit le pare-feu, le proxy et le certificat.",
  'empty.hint.readOnly':
    "Aucune sonde n'a encore été déclarée sur cette instance. En déclarer une demande la permission monitor:manage — un administrateur peut l'ajouter à votre rôle depuis Administration → Rôles.",
  'action.declare': 'Déclarer une sonde',
  'retention.note': {
    one: "Les mesures sont conservées {count} jour, puis purgées. Les incidents, eux, ne sont jamais purgés — ce sont eux qui racontent l'histoire.",
    other:
      "Les mesures sont conservées {count} jours, puis purgées. Les incidents, eux, ne sont jamais purgés — ce sont eux qui racontent l'histoire.",
  },


  // ── Carte d'une sonde ───────────────────────────────────────────────────
  'card.action.probe': 'Sonder',
  'card.action.pause': 'Suspendre',
  'card.action.resume': 'Reprendre',
  'card.action.detail': 'Détail',
  'card.paused': 'Sonde suspendue — {reason}. Elle se reprend avec « Reprendre ».',
  /**
   * Les motifs de suspension **automatiques**, rendus à la lecture.
   *
   * La colonne `paused_reason` porte une clé (`auto:orphaned`, …), pas une
   * phrase : traduire à l'écriture aurait figé la langue du jour du balayage.
   * L'écran retombe sur la valeur brute pour ce qu'il ne reconnaît pas — une
   * ligne écrite par une version d'avant, ou un motif saisi à la main.
   */
  'card.paused.orphaned': 'application plus déployée — sonde suspendue automatiquement',
  'card.paused.unknownType': 'type de sonde « {type} » inconnu de cette version du panel',
  'card.neverRan': 'Jamais exécutée — première mesure au prochain balayage.',
  'card.measured': 'il y a {since} · {cadence}',
  'card.pending': {
    one: '{count} échec sur {threshold} — non confirmé',
    other: '{count} échec sur {threshold} — non confirmé',
  },
  'card.badge.paused': 'suspendue',
  'card.window.day': '24 h',
  'card.window.week': '7 j',
  'card.incidentOpen': 'Incident ouvert depuis {since}.',
  'card.incidentTimeline': 'Voir la chronologie',
  /** Type absent du catalogue : la ligne le dit plutôt que d'afficher un code nu. */
  'type.unknown': 'type inconnu « {type} »',
  'target.unknownType': '(type inconnu)',

  // ── Figures ─────────────────────────────────────────────────────────────
  'chart.strip.label': {
    one: '{count} mesures, de la plus ancienne à la plus récente',
    other: '{count} mesures, de la plus ancienne à la plus récente',
  },
  'chart.sparkline.label': {
    one: 'Latence des {count} dernières mesures',
    other: 'Latence des {count} dernières mesures',
  },
  'chart.latency.label': 'Latence mesurée au cours du temps',
  'chart.point.title': '{clock} — {outcome}',
  'chart.point.titleWithLatency': '{clock} — {outcome} · {latency} ms',

  // ── Adoption ────────────────────────────────────────────────────────────
  'adopt.count': {
    one: '{count} application déployée n’est pas encore supervisée',
    other: '{count} applications déployées ne sont pas encore supervisées',
  },
  'adopt.short':
    "Pupitre ne crée pas de sonde tout seul : un clic suffit, avec l'URL de l'ingress.",
  'axis.now': 'maintenant',
  'card.more': 'Suspendre, supprimer',
  'card.open': 'Ouvrir la fiche de {name}',
  'delete.title': 'Supprimer la sonde « {name} » ?',
  'delete.checks': "Ses mesures, sa chronologie d'incidents et ses captures partent avec elle.",
  'delete.alerts': 'Plus aucune alerte ne partira pour cette adresse.',
  'delete.confirm': 'Supprimer la sonde',
  'toast.probed': 'Mesure de {name} demandée',
  'toast.probed.detail': 'Le résultat s’affiche au prochain rafraîchissement.',
  'toast.paused': '{name} suspendue',
  'toast.resumed': '{name} reprise',
  'toast.deleted': 'Sonde {name} supprimée',
  'toast.created': 'Sonde {name} déclarée',
  'drawer.kind': 'Sonde',
  'record.tabs': 'Sections de la fiche',
  'record.tab.overview': 'Aperçu',
  'record.tab.measures': 'Mesures et incidents',
  'record.tab.reference': 'Capture de référence',
  'drawer.target': 'Cible',
  'drawer.recent': 'Derniers passages',
  'drawer.last': 'Dernier relevé',
  'drawer.latency': 'Temps de réponse',
  'drawer.detail': 'Détail',
  'drawer.open': 'Ouvrir la fiche',
  'drawer.summary':
    '{typeLabel}, {cadence}. Panne confirmée après {failures}, rétablissement après {recovery} succès.',
  'adopt.action': 'Superviser {slug}',

  // ── Formulaire de création ──────────────────────────────────────────────
  'create.title': 'Nouvelle sonde',
  'create.name.label': 'Nom',
  'create.name.placeholder': 'Site vitrine',
  'create.type.label': 'Type de surveillance',
  'create.interval.label': 'Cadence',
  'create.interval.floor': 'Pas plus souvent que {cadence} pour ce type.',
  'create.failure.label': 'Seuil de panne',
  'create.failure.hint': "Échecs consécutifs avant l'incident. Un rebond isolé n'alerte pas.",
  'create.recovery.label': 'Seuil de rétablissement',
  'create.recovery.hint': "Succès consécutifs avant de refermer l'incident.",
  'create.webhook.label': "Webhook d'alerte",
  'create.webhook.placeholder': 'https://hooks.slack.com/services/…',
  'create.webhook.payload.a': 'Un POST JSON à la panne ',
  'create.webhook.payload.and': 'et',
  'create.webhook.payload.b': ' au rétablissement, jamais à chaque échec. La charge porte ',
  'create.webhook.payload.c': ' et',
  'create.webhook.payload.d':
    ", ce que lisent Slack et Discord. L'URL est chiffrée en base et n'est jamais réaffichée.",
  'create.webhook.scope.a': 'Ce webhook ne concerne ',
  'create.webhook.scope.only': 'que cette sonde',
  'create.webhook.scope.b':
    ". Les canaux de notification de l'instance (e-mail, Telegram, Discord, webhook) reçoivent déjà « Site en panne » et « Site rétabli » pour ",
  'create.webhook.scope.all': 'toutes',
  'create.webhook.scope.c':
    " les sondes s'ils y sont abonnés — avec regroupement des rafales. Renseigner les deux fait donc partir deux messages pour une même panne : à réserver au cas où cette sonde doit alerter ailleurs que les autres.",
  'create.submit': 'Créer la sonde',
  'edit.action': 'Modifier',
  'edit.title': 'Modifier « {name} »',
  'edit.type.fixed': "Le type ne se modifie pas : changer de type, c'est déclarer une autre sonde.",
  'edit.webhook.kept':
    'Un webhook est enregistré. Son URL reste masquée ; laissez le champ vide pour la conserver.',
  'edit.webhook.removing': "Le webhook sera retiré à l'enregistrement.",
  'edit.webhook.remove': 'Retirer',
  'edit.webhook.keep': 'Conserver',
  'edit.webhook.placeholder': "Nouvelle URL, pour remplacer l'actuelle",
  'edit.submit': 'Enregistrer',
  'edit.unchanged': 'Aucune modification à enregistrer.',
  'toast.updated': 'Sonde {name} enregistrée',

  // ── Champs de configuration, rendus depuis le catalogue ─────────────────
  'config.optional': 'facultatif',
  'config.advanced': 'Options avancées',

  // ── Détail ──────────────────────────────────────────────────────────────
  'detail.failures': {
    one: '{count} échec consécutif',
    other: '{count} échecs consécutifs',
  },

  'detail.readout.title': 'Dernier relevé',
  /**
   * `count` porte la valeur absolue — un certificat expiré rend « -3 jours » —
   * et `value` la valeur signée, celle qui s'affiche.
   */
  'detail.metric.days': { one: '{value} jour', other: '{value} jours' },

  'detail.latency.title': 'Latence mesurée',
  'detail.latency.sub': {
    one: '{count} dernière mesure, {cadence}',
    other: '{count} dernières mesures, {cadence}',
  },
  'detail.latency.gapNote':
    "Les bandes rouges marquent les mesures sans réponse : le trait est coupé plutôt qu'interpolé.",
  'detail.latency.empty': "Aucune mesure pour l'instant. La sonde n'a pas encore tourné.",

  'detail.incidents.title': 'Chronologie des incidents',
  'detail.incidents.sub': 'du plus récent au plus ancien',
  'detail.incident.since': 'depuis {clock}',
  'detail.incidents.empty': "Aucun incident. Cette sonde n'est jamais passée en panne confirmée.",
  'detail.incident.closed': 'Incident refermé',
  'detail.incident.open': 'Incident ouvert',
  'detail.incident.outage': '{duration} de panne',
  'detail.incident.ongoing': 'en cours depuis {since}',
  'detail.incident.confirmedAfter': {
    one: 'confirmé après {count} échec',
    other: 'confirmé après {count} échecs',
  },
  'detail.incident.alerted': 'alerte émise',
  'detail.incident.notAlerted': 'aucune alerte de panne',
  'detail.incident.resolveAlerted': 'rétablissement annoncé',
  'detail.incident.resolveNotAlerted': 'aucune alerte de rétablissement',
  'detail.incident.webhookFailed': 'Webhook non remis : {error}',

  'detail.checks.title': 'Mesures',
  'detail.checks.description': {
    one: "L'équivalent lisible sans couleur de la courbe et de la frise. Conservées {count} jour.",
    other:
      "L'équivalent lisible sans couleur de la courbe et de la frise. Conservées {count} jours.",
  },
  'detail.checks.count': { one: '{count} mesure', other: '{count} mesures' },
  'detail.checks.hint': 'afficher la table (équivalent lisible sans couleur)',
  'detail.checks.column.instant': 'Instant',
  'detail.checks.column.verdict': 'Verdict',

  // ── Captures ────────────────────────────────────────────────────────────
  'capture.kind.reference': 'avant',
  'capture.kind.incidentOpen': 'pendant',
  'capture.kind.incidentResolved': 'après',
  'capture.status': 'code {status}',
  'capture.truncated': 'page tronquée',
  'capture.truncated.title': 'La page était plus haute que la borne de rendu.',
  'capture.openFull': "Ouvrir l'image en taille réelle",
  'capture.alt': 'Capture « {kind} » du {clock}',
  'capture.purged': 'Image reprise par la rétention{when}. La capture a bien eu lieu — {size}.',
  'capture.purged.on': ' le {clock}',
  'capture.bytes.b': '{value} o',
  'capture.bytes.kb': '{value} Ko',
  'capture.bytes.mb': '{value} Mo',

  'slider.before.alt': "Page avant l'incident, {clock}",
  'slider.during.alt': "Page pendant l'incident, {clock}",
  'slider.before.badge': 'avant — {clock}',
  'slider.during.badge': 'pendant — {clock}',
  'slider.reveal': "Révéler l'avant",
  'slider.aria': "Position du comparateur entre la page avant l'incident et pendant l'incident",
  'slider.percent': '{value} %',

  'reference.title': 'Référence visuelle',
  'reference.description':
    "La page telle qu'elle était la dernière fois que tout allait bien. C'est le « avant » auquel le prochain incident sera comparé.",

  'captures.title': 'Ce que la sonde a vu',
  'captures.noReference':
    "Pas d'image de référence pour cet incident : la sonde n'avait pas encore été photographiée en bon état. La comparaison avant/après apparaîtra au prochain.",
  'captures.incomplete': "Il manque une des deux images : la comparaison n'est pas possible.",

  // ── Erreurs d'API ───────────────────────────────────────────────────────
  'error.monitorNotFound': 'Sonde « {id} » introuvable',
  'error.applicationNotFound': 'Application « {id} » introuvable',
  'error.captureNotFound': 'Capture « {id} » introuvable',
  'error.noJobId': "La tâche n'a pas reçu d'identifiant",

  /**
   * Les deux refus que `@pupitre/db` lève en donnée et que cette route met en
   * phrase. `{issue}` est le message du schéma Zod du type : il voyage tel
   * quel, en français, parce que les schémas de `@pupitre/core` ne sont pas
   * traduits.
   */
  'error.configInvalid': 'configuration de sonde « {label} » invalide — {path} : {issue}',
  'error.intervalTooShort':
    'une sonde « {label} » ne se lance pas plus souvent que {floor} — {asked} demandé',
} as const;

const en: Translated<typeof fr> = {
  'page.title': 'Probes',
  'page.description':
    "A monitor goes from the worker to a service's public address. It sees what the SSH healthcheck cannot: the firewall, the proxy, the certificate.",

  'outcome.healthy': 'healthy',
  'outcome.unhealthy': 'unhealthy',
  'outcome.unreachable': 'unreachable',
  'outcome.unknown': 'unknown',

  'health.healthy': 'running',
  'health.unhealthy': 'unhealthy',
  'health.unreachable': 'unreachable',
  'health.unknown': 'unknown state',

  'empty.title': 'No probe',
  'empty.hint.canManage':
    'A probe leaves the worker for the public address of what it watches. That is a different vantage point from the healthcheck: it sees the firewall, the proxy and the certificate.',
  'empty.hint.readOnly':
    'No probe has been declared on this instance yet. Declaring one needs the monitor:manage permission — an administrator can add it to your role from Administration → Roles.',
  'action.declare': 'Declare a probe',
  'retention.note': {
    one: 'Readouts are kept {count} day, then purged. Incidents are never purged — they are what tells the story.',
    other:
      'Readouts are kept {count} days, then purged. Incidents are never purged — they are what tells the story.',
  },


  'card.action.probe': 'Probe now',
  'card.action.pause': 'Pause',
  'card.action.resume': 'Resume',
  'card.action.detail': 'Details',
  'card.paused': 'Probe paused — {reason}. “Resume” starts it again.',
  'card.paused.orphaned': 'application no longer deployed — probe paused automatically',
  'card.paused.unknownType': 'probe type “{type}” is unknown to this version of the panel',
  'card.neverRan': 'Never ran — first readout on the next sweep.',
  'card.measured': '{since} ago · {cadence}',
  'card.pending': {
    one: '{count} failure out of {threshold} — not confirmed',
    other: '{count} failures out of {threshold} — not confirmed',
  },
  'card.badge.paused': 'paused',
  'card.window.day': '24 h',
  'card.window.week': '7 d',
  'card.incidentOpen': 'Incident open for {since}.',
  'card.incidentTimeline': 'See the timeline',
  'type.unknown': 'unknown type “{type}”',
  'target.unknownType': '(unknown type)',

  'chart.strip.label': {
    one: '{count} readout, oldest to most recent',
    other: '{count} readouts, oldest to most recent',
  },
  'chart.sparkline.label': {
    one: 'Latency over the last {count} readout',
    other: 'Latency over the last {count} readouts',
  },
  'chart.latency.label': 'Latency measured over time',
  'chart.point.title': '{clock} — {outcome}',
  'chart.point.titleWithLatency': '{clock} — {outcome} · {latency} ms',

  'adopt.count': {
    one: '{count} deployed application is not monitored yet',
    other: '{count} deployed applications are not monitored yet',
  },
  'adopt.short':
    'Pupitre never creates a monitor on its own: one click is enough, with the ingress URL.',
  'axis.now': 'now',
  'card.more': 'Pause, delete',
  'card.open': 'Open the record of {name}',
  'delete.title': 'Delete the monitor “{name}”?',
  'delete.checks': 'Its samples, its incident timeline and its captures go with it.',
  'delete.alerts': 'No alert will leave for this address anymore.',
  'delete.confirm': 'Delete the monitor',
  'toast.probed': 'Check of {name} requested',
  'toast.probed.detail': 'The result shows at the next refresh.',
  'toast.paused': '{name} paused',
  'toast.resumed': '{name} resumed',
  'toast.deleted': 'Monitor {name} deleted',
  'toast.created': 'Monitor {name} declared',
  'drawer.kind': 'Monitor',
  'record.tabs': 'Record sections',
  'record.tab.overview': 'Overview',
  'record.tab.measures': 'Checks and incidents',
  'record.tab.reference': 'Reference capture',
  'drawer.target': 'Target',
  'drawer.recent': 'Latest checks',
  'drawer.last': 'Latest readout',
  'drawer.latency': 'Response time',
  'drawer.detail': 'Detail',
  'drawer.open': 'Open the page',
  'drawer.summary':
    '{typeLabel}, {cadence}. Outage confirmed after {failures}, recovery after {recovery} successes.',
  'adopt.action': 'Watch {slug}',

  'create.title': 'New probe',
  'create.name.label': 'Name',
  'create.name.placeholder': 'Marketing site',
  'create.type.label': 'What to watch',
  'create.interval.label': 'Cadence',
  'create.interval.floor': 'No more often than {cadence} for this type.',
  'create.failure.label': 'Failure threshold',
  'create.failure.hint': 'Consecutive failures before the incident. A single blip raises nothing.',
  'create.recovery.label': 'Recovery threshold',
  'create.recovery.hint': 'Consecutive successes before the incident closes.',
  'create.webhook.label': 'Alert webhook',
  'create.webhook.placeholder': 'https://hooks.slack.com/services/…',
  'create.webhook.payload.a': 'One JSON POST on the outage ',
  'create.webhook.payload.and': 'and',
  'create.webhook.payload.b': ' on the recovery, never on every failure. The payload carries ',
  'create.webhook.payload.c': ' and',
  'create.webhook.payload.d':
    ', which is what Slack and Discord read. The URL is encrypted in the database and never shown again.',
  'create.webhook.scope.a': 'This webhook covers ',
  'create.webhook.scope.only': 'this probe only',
  'create.webhook.scope.b':
    '. The instance notification channels (email, Telegram, Discord, webhook) already get “Site down” and “Site recovered” for ',
  'create.webhook.scope.all': 'every',
  'create.webhook.scope.c':
    ' probe they subscribe to — bursts grouped. Filling in both therefore sends two messages for one outage: keep it for a probe that must alert somewhere the others do not.',
  'create.submit': 'Create the probe',
  'edit.action': 'Edit',
  'edit.title': 'Edit “{name}”',
  'edit.type.fixed': 'The type cannot change: another type means declaring another probe.',
  'edit.webhook.kept':
    'A webhook is saved. Its URL stays hidden; leave the field empty to keep it.',
  'edit.webhook.removing': 'The webhook will be removed on save.',
  'edit.webhook.remove': 'Remove',
  'edit.webhook.keep': 'Keep',
  'edit.webhook.placeholder': 'New URL, to replace the current one',
  'edit.submit': 'Save',
  'edit.unchanged': 'No change to save.',
  'toast.updated': 'Monitor {name} saved',

  'config.optional': 'optional',
  'config.advanced': 'Advanced options',

  'detail.failures': {
    one: '{count} consecutive failure',
    other: '{count} consecutive failures',
  },

  'detail.readout.title': 'Latest readout',
  'detail.metric.days': { one: '{value} day', other: '{value} days' },

  'detail.latency.title': 'Latency measured',
  'detail.latency.sub': {
    one: 'last {count} sample, {cadence}',
    other: 'last {count} samples, {cadence}',
  },
  'detail.latency.gapNote':
    'Red bands mark samples with no answer: the line is cut rather than interpolated.',
  'detail.latency.empty': 'No readout yet. The probe has not run.',

  'detail.incidents.title': 'Incident timeline',
  'detail.incidents.sub': 'most recent first',
  'detail.incident.since': 'since {clock}',
  'detail.incidents.empty': 'No incident. This probe has never gone to a confirmed outage.',
  'detail.incident.closed': 'Incident closed',
  'detail.incident.open': 'Incident open',
  'detail.incident.outage': '{duration} down',
  'detail.incident.ongoing': 'ongoing for {since}',
  'detail.incident.confirmedAfter': {
    one: 'confirmed after {count} failure',
    other: 'confirmed after {count} failures',
  },
  'detail.incident.alerted': 'alert sent',
  'detail.incident.notAlerted': 'no outage alert',
  'detail.incident.resolveAlerted': 'recovery announced',
  'detail.incident.resolveNotAlerted': 'no recovery alert',
  'detail.incident.webhookFailed': 'Webhook not delivered: {error}',

  'detail.checks.title': 'Readouts',
  'detail.checks.description': {
    one: 'The colorless equivalent of the chart and the strip. Kept {count} day.',
    other: 'The colorless equivalent of the chart and the strip. Kept {count} days.',
  },
  'detail.checks.count': { one: '{count} sample', other: '{count} samples' },
  'detail.checks.hint': 'show the table (readable without colour)',
  'detail.checks.column.instant': 'Instant',
  'detail.checks.column.verdict': 'Verdict',

  'capture.kind.reference': 'before',
  'capture.kind.incidentOpen': 'during',
  'capture.kind.incidentResolved': 'after',
  'capture.status': 'status {status}',
  'capture.truncated': 'page cut',
  'capture.truncated.title': 'The page was taller than the render bound.',
  'capture.openFull': 'Open the image at full size',
  'capture.alt': 'Capture “{kind}” taken {clock}',
  'capture.purged': 'Image reclaimed by retention{when}. The capture did happen — {size}.',
  'capture.purged.on': ' on {clock}',
  'capture.bytes.b': '{value} B',
  'capture.bytes.kb': '{value} KB',
  'capture.bytes.mb': '{value} MB',

  'slider.before.alt': 'Page before the incident, {clock}',
  'slider.during.alt': 'Page during the incident, {clock}',
  'slider.before.badge': 'before — {clock}',
  'slider.during.badge': 'during — {clock}',
  'slider.reveal': 'Reveal the before',
  'slider.aria': 'Comparator position between the page before and during the incident',
  'slider.percent': '{value}%',

  'reference.title': 'Visual reference',
  'reference.description':
    'The page as it was the last time all was well. That is the “before” the next incident will be compared to.',

  'captures.title': 'What the probe saw',
  'captures.noReference':
    'No reference image for this incident: the probe had not been photographed in good health yet. The before/after comparison will show up on the next one.',
  'captures.incomplete': 'One of the two images is missing: no comparison is possible.',

  'error.monitorNotFound': 'No probe “{id}”',
  'error.applicationNotFound': 'No application “{id}”',
  'error.captureNotFound': 'No capture “{id}”',
  'error.noJobId': 'The job got no ID',
  'error.configInvalid': 'invalid “{label}” probe configuration — {path}: {issue}',
  'error.intervalTooShort': 'a “{label}” probe runs no more often than {floor} — {asked} asked',
};

export const monitors = { fr, en };
