import { z } from 'zod';
import { translator, type Translate, type Translated, type UiLanguage } from '../i18n.js';
import { monitorTypeSchema, type MonitorType } from './catalog.js';

/**
 * Ce qui est commun à **tous** les types de sonde : le verdict, la machine à
 * états, le taux de disponibilité, la charge utile d'alerte, la rétention.
 *
 * Rien ici ne connaît HTTP. Un type qui arrive plus tard — DNS, expiration de
 * domaine — hérite de tout ce fichier sans y ajouter une ligne.
 */

/**
 * Verdict d'une mesure, quel que soit le type :
 *   healthy      ce qu'on attendait
 *   unhealthy    la cible a répondu, mais pas comme prévu
 *   unreachable  rien n'a répondu (DNS, TCP, TLS, délai dépassé)
 *
 * Volontairement calqué sur `health_status` en base. Ce n'est pas de la
 * paresse : l'écran réutilise le voyant `HealthDot` du reste du panel, donc la
 * même convention de lecture.
 */
export const monitorOutcomeSchema = z.enum(['healthy', 'unhealthy', 'unreachable']);
export type MonitorOutcome = z.infer<typeof monitorOutcomeSchema>;

/** État **confirmé** d'une sonde. `unknown` tant qu'aucune mesure n'est passée. */
export const monitorStatusSchema = z.enum(['unknown', 'healthy', 'unhealthy', 'unreachable']);
export type MonitorStatus = z.infer<typeof monitorStatusSchema>;

/**
 * Les mesures d'un relevé. Un espace **ouvert et structuré**, parce qu'un
 * résultat n'a pas les mêmes mesures selon le type : une sonde HTTP rend une
 * latence et un code, une sonde TLS des jours restants et un émetteur. Le
 * catalogue dit à l'écran comment afficher chaque clé ; personne ne force ça
 * dans des colonnes HTTP.
 */
export const metricValueSchema = z.union([z.number(), z.string(), z.null()]);
export type MetricValue = z.infer<typeof metricValueSchema>;
export const checkMetricsSchema = z.record(z.string(), metricValueSchema);
export type CheckMetrics = z.infer<typeof checkMetricsSchema>;

/** Ce que toute sonde rend, quel que soit son type. */
export const checkResultSchema = z.object({
  outcome: monitorOutcomeSchema,
  /** Durée de la mesure, quand elle a un sens. `null` si rien n'a répondu. */
  latencyMs: z.number().int().nonnegative().nullable(),
  /** Ce qui a été constaté, en une phrase. Toujours renseigné quand ça rate. */
  detail: z.string().nullable(),
  metrics: checkMetricsSchema,
});
export type CheckResult = z.infer<typeof checkResultSchema>;

// ─── bornes communes ──────────────────────────────────────────────────────────

export const MONITOR_THRESHOLD_MIN = 1;
export const MONITOR_THRESHOLD_MAX = 10;
export const MONITOR_FAILURE_THRESHOLD_DEFAULT = 3;
export const MONITOR_RECOVERY_THRESHOLD_DEFAULT = 2;

/**
 * Rétention de `monitor_checks` : **30 jours**.
 *
 * Une sonde à la minute produit 1 440 lignes par jour, 43 200 par mois, un peu
 * plus d'un demi-million par an. Trente jours couvrent les deux fenêtres que
 * l'écran affiche (24 h et 7 j), laissent la place à un regard « le mois
 * dernier » quand on enquête sur une panne, et plafonnent une instance de
 * cinquante sondes à ~2,2 millions de lignes — une taille que l'index
 * `(monitor_id, checked_at desc)` absorbe sans effort.
 *
 * Au-delà, la mesure brute ne paie plus sa place : ce qu'on veut d'un
 * historique plus long, ce sont des agrégats journaliers, pas 500 000 lignes.
 * Les **incidents**, eux, ne sont jamais purgés : ils sont rares, et ce sont eux
 * qui racontent l'histoire.
 */
export const MONITOR_CHECK_RETENTION_DAYS = 30;

/** Purge par lots : un `DELETE` de plusieurs millions de lignes tiendrait la table. */
export const MONITOR_PRUNE_BATCH = 20_000;

/**
 * Taille de réponse lue, au maximum. Un flux infini servi à une sonde qui passe
 * toutes les minutes épuise le worker en quelques heures.
 */
export const MONITOR_MAX_RESPONSE_BYTES = 256 * 1024;

/** Redirections suivies. Chacune est re-contrôlée par la politique SSRF. */
export const MONITOR_MAX_REDIRECTS = 5;

export const MONITOR_USER_AGENT = 'pupitre-monitor/1';

/** Cadence du balayage. Fixe : c'est un détail d'exécution, pas un réglage. */
export const MONITOR_SWEEP_EVERY_MS = 30_000;

/**
 * Temps de travail d'un balayage. Bien sous la cadence : un balayage qui
 * déborde laisse simplement les sondes restantes au suivant, elles sont
 * toujours dues.
 */
export const MONITOR_SWEEP_BUDGET_MS = 22_000;

/** Sondes menées de front dans un balayage. */
export const MONITOR_SWEEP_CONCURRENCY = 10;

/** Sondes réclamées au plus par balayage. */
export const MONITOR_SWEEP_BATCH = 200;

/** Mesures affichées dans la courbe compacte de la liste. */
export const MONITOR_SPARKLINE_POINTS = 40;

// ─── machine à états ──────────────────────────────────────────────────────────

/**
 * Un **incident est une transition**, pas une ligne de la série temporelle.
 *
 * Le rebond — une mesure qui rate puis repasse — ne doit rien déclencher :
 * c'est le cas le plus fréquent, et cinquante messages pour une panne de deux
 * minutes, personne ne les lit. D'où un seuil de confirmation, réglable par
 * sonde : `failureThreshold` échecs consécutifs pour ouvrir, `recoveryThreshold`
 * succès consécutifs pour refermer.
 *
 * L'état **confirmé** (`status`) ne bouge donc qu'aux transitions. Le dernier
 * verdict brut est conservé à part (`lastOutcome`), ce qui permet à l'écran de
 * dire « 1 échec sur 3 — non confirmé » plutôt que de mentir dans un sens ou
 * dans l'autre.
 */
export type MonitorState = {
  status: MonitorStatus;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  /**
   * Un incident est-il ouvert ? D'ordinaire, c'est exactement « l'état
   * confirmé est une panne ». Pas toujours : changer ce qu'une sonde observe
   * remet son état à `unknown` — le verdict portait sur autre chose — sans
   * refermer l'incident, qui a été annoncé. Sans ce champ, la machine croyait
   * alors n'avoir « rien à refermer » : le retour à la normale passait sous
   * silence, l'incident restait ouvert pour toujours, et l'index unique
   * avalait chaque panne suivante.
   */
  incidentOpen: boolean;
};

export type MonitorThresholds = {
  failureThreshold: number;
  recoveryThreshold: number;
};

export type MonitorTransition = 'down' | 'up' | null;

export type MonitorStep = MonitorState & { transition: MonitorTransition };

export function nextMonitorState(
  previous: MonitorState,
  outcome: MonitorOutcome,
  thresholds: MonitorThresholds,
): MonitorStep {
  const healthy = outcome === 'healthy';

  const consecutiveFailures = healthy ? 0 : previous.consecutiveFailures + 1;
  const consecutiveSuccesses = healthy ? previous.consecutiveSuccesses + 1 : 0;

  // En incident : la panne a été confirmée et annoncée. L'état le dit
  // (`unhealthy`, `unreachable`), ou il a été remis à `unknown` par un
  // changement de cible pendant la panne — l'incident, lui, court toujours.
  const inIncident =
    previous.incidentOpen || previous.status === 'unhealthy' || previous.status === 'unreachable';

  if (healthy) {
    // Hors incident, une seule mesure saine suffit à afficher « sain » : il n'y
    // a rien à refermer, donc rien à confirmer. En incident, le rétablissement
    // demande son seuil — et il s'annonce, même si l'état affiché était `unknown`.
    const recovered = !inIncident || consecutiveSuccesses >= thresholds.recoveryThreshold;
    if (!recovered) {
      return {
        status: previous.status,
        consecutiveFailures,
        consecutiveSuccesses,
        incidentOpen: inIncident,
        transition: null,
      };
    }
    return {
      status: 'healthy',
      consecutiveFailures,
      consecutiveSuccesses,
      incidentOpen: false,
      transition: inIncident ? 'up' : null,
    };
  }

  if (inIncident) {
    // Déjà en panne : on met à jour la nature de l'échec sans rouvrir d'incident.
    return {
      status: outcome,
      consecutiveFailures,
      consecutiveSuccesses,
      incidentOpen: true,
      transition: null,
    };
  }

  if (consecutiveFailures < thresholds.failureThreshold) {
    return {
      status: previous.status,
      consecutiveFailures,
      consecutiveSuccesses,
      incidentOpen: false,
      transition: null,
    };
  }

  return {
    status: outcome,
    consecutiveFailures,
    consecutiveSuccesses,
    incidentOpen: true,
    transition: 'down',
  };
}

// ─── suspension ───────────────────────────────────────────────────────────────

/**
 * Pourquoi une sonde a été suspendue — une **donnée**, pas une phrase.
 *
 * ── Le piège qu'on évite ────────────────────────────────────────────────────
 * `monitors.paused_reason` est une colonne : ce qu'on y écrit reste écrit. Y
 * poser « application plus déployée — sonde suspendue automatiquement » figeait
 * la langue **au moment du balayage**, pour toujours, et pour tous les lecteurs
 * — y compris celui qui basculerait l'instance en anglais l'année suivante. Une
 * traduction à l'écriture n'est pas une traduction, c'est un enregistrement.
 *
 * ── Pourquoi une clé, et non une énumération ────────────────────────────────
 * La colonne reste du texte libre, et c'est délibéré. Deux raisons :
 *   • les lignes **déjà en base** portent la vieille phrase française, et une
 *     énumération les rendrait illisibles ou obligerait à une migration qui
 *     réécrit un fait passé ;
 *   • rien n'interdit qu'un jour un humain y écrive son propre motif, et une
 *     énumération le lui refuserait.
 *
 * D'où le contrat : les motifs **automatiques** s'écrivent avec le préfixe
 * `auto:`, l'écran les reconnaît et les rend dans sa langue, et **retombe sur la
 * valeur brute** dès qu'il ne reconnaît pas. Une vieille ligne s'affiche donc
 * telle qu'elle a été écrite, sans rien casser.
 */
export const MONITOR_PAUSE_ORPHANED = 'auto:orphaned';

const UNKNOWN_TYPE_PREFIX = 'auto:unknown-type:';

/** Motif d'une sonde dont le type n'existe plus dans cette version du panel. */
export function monitorPauseUnknownType(type: string): string {
  return `${UNKNOWN_TYPE_PREFIX}${type}`;
}

export type MonitorPause =
  | { reason: 'orphaned' }
  | { reason: 'unknownType'; type: string }
  /** Ce que l'écran ne reconnaît pas : une ligne d'avant, ou un motif libre. */
  | { reason: 'free'; text: string };

export function parseMonitorPause(raw: string): MonitorPause {
  if (raw === MONITOR_PAUSE_ORPHANED) return { reason: 'orphaned' };
  if (raw.startsWith(UNKNOWN_TYPE_PREFIX)) {
    return { reason: 'unknownType', type: raw.slice(UNKNOWN_TYPE_PREFIX.length) };
  }
  return { reason: 'free', text: raw };
}

// ─── taux de disponibilité ────────────────────────────────────────────────────

/**
 * Un taux sans son dénominateur ne veut rien dire : « 100 % sur 3 mesures »
 * n'est pas « 100 % sur 1 440 ». L'écran affiche toujours les deux, et une
 * fenêtre sans aucune mesure rend `null` — pas 0 %.
 */
export type UptimeWindow = {
  hours: number;
  samples: number;
  up: number;
  ratio: number | null;
};

export function uptimeRatio(up: number, samples: number): number | null {
  if (samples <= 0) return null;
  return up / samples;
}

/**
 * Les mots des durées, des taux et des alertes — et rien que les mots.
 *
 * Ces quatre formats s'affichent partout : sous chaque carte de sonde, dans le
 * bandeau du détail, dans la liste des tâches planifiées. Les laisser en dur
 * revenait à laisser une phrase française sur un écran anglais à chaque ligne.
 * Les entrées `alert.*`, elles, ne s'affichent pas : elles partent vers Slack,
 * Discord ou un récepteur maison. C'est le même besoin — personne n'est devant
 * l'écran, donc la langue est celle de l'instance, et le worker la passe.
 *
 * Deux clés portent une divergence de langue que rien d'autre ne pouvait
 * absorber : `cadence.every.masculine` et `cadence.every.feminine`. Le français
 * accorde l'article avec ce qui suit — « toutes les minutes », « tous les
 * jours » — quand l'anglais dit *every* dans les deux cas. Le choix se fait
 * donc du côté du code, et l'anglais rend simplement la même phrase deux fois.
 */
const fr = {
  'uptime.none': 'aucune mesure',
  'uptime.ratio': {
    one: '{percent} % sur {count} mesure',
    other: '{percent} % sur {count} mesures',
  },

  'duration.seconds': '{value} s',
  'duration.minutes': '{value} min',
  'duration.hours': '{value} h',
  'duration.hoursMinutes': '{hours} h {minutes} min',
  'duration.days': '{value} j',

  'interval.seconds': { one: '{count} seconde', other: '{count} secondes' },
  'interval.minutes': { one: '{count} minute', other: '{count} minutes' },
  'interval.hours': { one: '{count} heure', other: '{count} heures' },
  'interval.days': { one: '{count} jour', other: '{count} jours' },

  'cadence.daily': 'tous les jours',
  'cadence.hourly': 'toutes les heures',
  'cadence.minutely': 'toutes les minutes',
  'cadence.every.masculine': 'tous les {interval}',
  'cadence.every.feminine': 'toutes les {interval}',

  'alert.down': '🔴 {name} — {target} · {failures}',
  'alert.down.detail': '🔴 {name} — {target} : {detail} · {failures}',
  'alert.failures': {
    one: '{count} échec consécutif',
    other: '{count} échecs consécutifs',
  },
  'alert.up': '🟢 {name} est rétablie — {target}',
  'alert.up.outage': '🟢 {name} est rétablie — {target} · panne de {duration}',
} as const;

const en: Translated<typeof fr> = {
  'uptime.none': 'no readouts',
  'uptime.ratio': {
    one: '{percent}% over {count} readout',
    other: '{percent}% over {count} readouts',
  },

  'duration.seconds': '{value} s',
  'duration.minutes': '{value} min',
  'duration.hours': '{value} h',
  'duration.hoursMinutes': '{hours} h {minutes} min',
  'duration.days': '{value} d',

  'interval.seconds': { one: '{count} second', other: '{count} seconds' },
  'interval.minutes': { one: '{count} minute', other: '{count} minutes' },
  'interval.hours': { one: '{count} hour', other: '{count} hours' },
  'interval.days': { one: '{count} day', other: '{count} days' },

  'cadence.daily': 'every day',
  'cadence.hourly': 'every hour',
  'cadence.minutely': 'every minute',
  'cadence.every.masculine': 'every {interval}',
  'cadence.every.feminine': 'every {interval}',

  'alert.down': '🔴 {name} — {target} · {failures}',
  'alert.down.detail': '🔴 {name} — {target}: {detail} · {failures}',
  'alert.failures': {
    one: '{count} consecutive failure',
    other: '{count} consecutive failures',
  },
  'alert.up': '🟢 {name} recovered — {target}',
  'alert.up.outage': '🟢 {name} recovered — {target} · down for {duration}',
};

export const monitorStateCopy = { fr, en };

type StateTranslate = Translate<typeof fr>;

/**
 * Le défaut reste le français, comme pour le catalogue : le worker et la base
 * appellent ces formats sans avoir de langue d'instance à offrir. Le panel, lui,
 * passe la sienne.
 */
function copy(language: UiLanguage): StateTranslate {
  return translator(monitorStateCopy, language);
}

export function formatUptime(window: UptimeWindow, language: UiLanguage = 'fr'): string {
  const t = copy(language);
  if (window.ratio === null) return t('uptime.none');
  const percent = window.ratio * 100;
  // Deux décimales sous 100 % : 99,93 % et 99,99 %, ce n'est pas la même panne.
  // La virgule décimale du français et le point de l'anglais viennent d'`Intl`,
  // pas d'un remplacement à la main.
  const text =
    percent === 100
      ? '100'
      : new Intl.NumberFormat(language, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(percent);
  return t('uptime.ratio', { percent: text, count: window.samples });
}

export function formatDuration(seconds: number, language: UiLanguage = 'fr'): string {
  const t = copy(language);
  if (seconds < 60) return t('duration.seconds', { value: seconds });
  if (seconds < 3600) return t('duration.minutes', { value: Math.floor(seconds / 60) });
  if (seconds < 86_400) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes === 0
      ? t('duration.hours', { value: hours })
      : t('duration.hoursMinutes', { hours, minutes });
  }
  return t('duration.days', { value: Math.floor(seconds / 86_400) });
}

/** Une durée, en toutes lettres : « 30 secondes », « 6 heures », « 1 jour ». */
export function formatInterval(seconds: number, language: UiLanguage = 'fr'): string {
  const t = copy(language);
  if (seconds < 60) return t('interval.seconds', { count: seconds });
  if (seconds % 86_400 === 0) return t('interval.days', { count: seconds / 86_400 });
  if (seconds % 3_600 === 0) return t('interval.hours', { count: seconds / 3_600 });
  return t('interval.minutes', { count: Math.round(seconds / 60) });
}

/**
 * La même durée, en cadence : « toutes les 30 secondes », « tous les jours ».
 *
 * Fonction à part parce que le français ne se laisse pas composer : « toutes
 * les » devant une minute, « tous les » devant un jour. Concaténer une durée
 * après un « toutes les » figé produisait « toutes les heure ».
 */
export function formatCadence(seconds: number, language: UiLanguage = 'fr'): string {
  const t = copy(language);
  if (seconds === 86_400) return t('cadence.daily');
  if (seconds === 3_600) return t('cadence.hourly');
  if (seconds === 60) return t('cadence.minutely');
  const interval = formatInterval(seconds, language);
  const masculine = seconds % 86_400 === 0 && seconds >= 86_400;
  return t(masculine ? 'cadence.every.masculine' : 'cadence.every.feminine', { interval });
}

// ─── alerte ───────────────────────────────────────────────────────────────────

/**
 * Un **webhook sortant**, et rien d'autre pour l'instant. Une requête POST avec
 * une charge utile JSON couvre Slack, Discord, Teams et n'importe quel
 * récepteur maison d'un seul mécanisme. Il n'y a pas de mailer dans ce projet,
 * et en ajouter un pour cette fonctionnalité serait commencer par le plus
 * coûteux.
 *
 * La charge porte `text` **et** `content` en plus du corps structuré : c'est ce
 * que lisent respectivement Slack et Discord, de sorte qu'un webhook collé tel
 * quel affiche une phrase lisible sans transformation.
 */
export const monitorAlertSchema = z.object({
  event: z.enum(['monitor.down', 'monitor.up']),
  at: z.string(),
  text: z.string(),
  content: z.string(),
  monitor: z.object({
    id: z.string(),
    name: z.string(),
    type: monitorTypeSchema,
    /** La cible, en une ligne — une URL pour HTTP, un hôte:port pour TLS. */
    target: z.string(),
  }),
  incident: z.object({
    id: z.string(),
    startedAt: z.string(),
    resolvedAt: z.string().nullable(),
    durationSeconds: z.number().int().nonnegative().nullable(),
  }),
  status: monitorStatusSchema,
  detail: z.string().nullable(),
  metrics: checkMetricsSchema,
  consecutiveFailures: z.number().int().nonnegative(),
});

export type MonitorAlert = z.infer<typeof monitorAlertSchema>;

/**
 * La phrase de l'alerte se rend **ici**, dans la langue qu'on lui donne.
 *
 * Elle part vers des canaux, pas vers un écran : personne n'est devant, donc la
 * langue est celle de l'instance. Le worker la lit dans les paramètres et la
 * passe ; le défaut reste le français, comme partout dans ce fichier, pour les
 * appelants qui n'en ont pas — un test, un script.
 */
export function buildMonitorAlert(
  input: {
    event: 'monitor.down' | 'monitor.up';
    monitor: { id: string; name: string; type: MonitorType; target: string };
    incident: { id: string; startedAt: Date; resolvedAt: Date | null };
    status: MonitorStatus;
    detail: string | null;
    metrics: CheckMetrics;
    consecutiveFailures: number;
    at?: Date;
  },
  language: UiLanguage = 'fr',
): MonitorAlert {
  const t = copy(language);
  const at = input.at ?? new Date();
  const durationSeconds = input.incident.resolvedAt
    ? Math.max(
        0,
        Math.round(
          (input.incident.resolvedAt.getTime() - input.incident.startedAt.getTime()) / 1000,
        ),
      )
    : null;

  const text =
    input.event === 'monitor.down'
      ? t(input.detail ? 'alert.down.detail' : 'alert.down', {
          name: input.monitor.name,
          target: input.monitor.target,
          detail: input.detail ?? '',
          failures: t('alert.failures', { count: input.consecutiveFailures }),
        })
      : t(durationSeconds === null ? 'alert.up' : 'alert.up.outage', {
          name: input.monitor.name,
          target: input.monitor.target,
          duration: formatDuration(durationSeconds ?? 0, language),
        });

  return {
    event: input.event,
    at: at.toISOString(),
    text,
    content: text,
    monitor: input.monitor,
    incident: {
      id: input.incident.id,
      startedAt: input.incident.startedAt.toISOString(),
      resolvedAt: input.incident.resolvedAt?.toISOString() ?? null,
      durationSeconds,
    },
    status: input.status,
    detail: input.detail,
    metrics: input.metrics,
    consecutiveFailures: input.consecutiveFailures,
  };
}
