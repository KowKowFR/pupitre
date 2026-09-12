import { z } from 'zod';
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

  const confirmedDown = previous.status === 'unhealthy' || previous.status === 'unreachable';

  if (healthy) {
    // Depuis `unknown`, une seule mesure saine suffit à afficher « sain » : il
    // n'y a pas d'incident à refermer, donc rien à confirmer.
    const recovered = !confirmedDown || consecutiveSuccesses >= thresholds.recoveryThreshold;
    if (!recovered) {
      return {
        status: previous.status,
        consecutiveFailures,
        consecutiveSuccesses,
        transition: null,
      };
    }
    return {
      status: 'healthy',
      consecutiveFailures,
      consecutiveSuccesses,
      transition: confirmedDown ? 'up' : null,
    };
  }

  if (confirmedDown) {
    // Déjà en panne : on met à jour la nature de l'échec sans rouvrir d'incident.
    return { status: outcome, consecutiveFailures, consecutiveSuccesses, transition: null };
  }

  if (consecutiveFailures < thresholds.failureThreshold) {
    return { status: previous.status, consecutiveFailures, consecutiveSuccesses, transition: null };
  }

  return { status: outcome, consecutiveFailures, consecutiveSuccesses, transition: 'down' };
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

export function formatUptime(window: UptimeWindow): string {
  if (window.ratio === null) return 'aucune mesure';
  const percent = window.ratio * 100;
  // Deux décimales sous 100 % : 99,93 % et 99,99 %, ce n'est pas la même panne.
  const text = percent === 100 ? '100' : percent.toFixed(2).replace('.', ',');
  return `${text} % sur ${window.samples} mesure${window.samples > 1 ? 's' : ''}`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
  }
  return `${Math.floor(seconds / 86_400)} j`;
}

/** Une durée, en toutes lettres : « 30 secondes », « 6 heures », « 1 jour ». */
export function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds} seconde${seconds > 1 ? 's' : ''}`;
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return `${days} jour${days > 1 ? 's' : ''}`;
  }
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return `${hours} heure${hours > 1 ? 's' : ''}`;
  }
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes > 1 ? 's' : ''}`;
}

/**
 * La même durée, en cadence : « toutes les 30 secondes », « tous les jours ».
 *
 * Fonction à part parce que le français ne se laisse pas composer : « toutes
 * les » devant une minute, « tous les » devant un jour. Concaténer une durée
 * après un « toutes les » figé produisait « toutes les heure ».
 */
export function formatCadence(seconds: number): string {
  const interval = formatInterval(seconds);
  const masculine = seconds % 86_400 === 0 && seconds >= 86_400;
  if (seconds === 86_400) return 'tous les jours';
  if (seconds === 3_600) return 'toutes les heures';
  if (seconds === 60) return 'toutes les minutes';
  return `${masculine ? 'tous les' : 'toutes les'} ${interval}`;
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

export function buildMonitorAlert(input: {
  event: 'monitor.down' | 'monitor.up';
  monitor: { id: string; name: string; type: MonitorType; target: string };
  incident: { id: string; startedAt: Date; resolvedAt: Date | null };
  status: MonitorStatus;
  detail: string | null;
  metrics: CheckMetrics;
  consecutiveFailures: number;
  at?: Date;
}): MonitorAlert {
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
      ? `🔴 ${input.monitor.name} — ${input.monitor.target}` +
        (input.detail ? ` : ${input.detail}` : '') +
        ` · ${input.consecutiveFailures} échec(s) consécutif(s)`
      : `🟢 ${input.monitor.name} est rétablie — ${input.monitor.target}` +
        (durationSeconds === null ? '' : ` · panne de ${formatDuration(durationSeconds)}`);

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
