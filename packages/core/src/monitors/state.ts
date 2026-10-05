import { z } from 'zod';
import { translator, type Translate, type Translated, type UiLanguage } from '../i18n.js';
import { monitorTypeSchema, type MonitorType } from './catalog.js';

/**
 * What is common to **every** probe type: the verdict, the state machine, the
 * availability rate, the alert payload, retention.
 *
 * Nothing here knows HTTP. A type that comes later — DNS, domain expiry —
 * inherits this whole file without adding a line to it.
 */

/**
 * A measurement's verdict, whatever the type:
 *   healthy      what was expected
 *   unhealthy    the target answered, but not as planned
 *   unreachable  nothing answered (DNS, TCP, TLS, timeout)
 *
 * Deliberately modeled on `health_status` in the database. It is not laziness:
 * the screen reuses the rest of the panel's `HealthDot` light, hence the same
 * reading convention.
 */
export const monitorOutcomeSchema = z.enum(['healthy', 'unhealthy', 'unreachable']);
export type MonitorOutcome = z.infer<typeof monitorOutcomeSchema>;

/** A probe's **confirmed** state. `unknown` as long as no measurement has passed. */
export const monitorStatusSchema = z.enum(['unknown', 'healthy', 'unhealthy', 'unreachable']);
export type MonitorStatus = z.infer<typeof monitorStatusSchema>;

/**
 * A reading's measurements. An **open and structured** space, because a result
 * does not have the same measurements depending on the type: an HTTP probe
 * returns a latency and a code, a TLS probe days left and an issuer. The catalog
 * tells the screen how to show each key; nobody forces that into HTTP columns.
 */
export const metricValueSchema = z.union([z.number(), z.string(), z.null()]);
export type MetricValue = z.infer<typeof metricValueSchema>;
export const checkMetricsSchema = z.record(z.string(), metricValueSchema);
export type CheckMetrics = z.infer<typeof checkMetricsSchema>;

/** What every probe returns, whatever its type. */
export const checkResultSchema = z.object({
  outcome: monitorOutcomeSchema,
  /** Duration of the measurement, when it makes sense. `null` if nothing answered. */
  latencyMs: z.number().int().nonnegative().nullable(),
  /** What was observed, in one sentence. Always filled in when it fails. */
  detail: z.string().nullable(),
  metrics: checkMetricsSchema,
});
export type CheckResult = z.infer<typeof checkResultSchema>;

// ─── shared bounds ────────────────────────────────────────────────────────────

export const MONITOR_THRESHOLD_MIN = 1;
export const MONITOR_THRESHOLD_MAX = 10;
export const MONITOR_FAILURE_THRESHOLD_DEFAULT = 3;
export const MONITOR_RECOVERY_THRESHOLD_DEFAULT = 2;

/**
 * Retention of `monitor_checks`: **30 days**.
 *
 * A probe every minute produces 1,440 rows a day, 43,200 a month, a little more
 * than half a million a year. Thirty days cover the two windows the screen shows
 * (24 h and 7 d), leave room for a "last month" look when investigating an
 * outage, and cap an instance with fifty probes at ~2.2 million rows — a size
 * the `(monitor_id, checked_at desc)` index absorbs effortlessly.
 *
 * Beyond that, the raw measurement no longer pays its place: what one wants
 * from a longer history are daily aggregates, not 500,000 rows. **Incidents**
 * are never purged: they are rare, and they are what tells the story.
 */
export const MONITOR_CHECK_RETENTION_DAYS = 30;

/** Purge in batches: a `DELETE` of several million rows would hold the table. */
export const MONITOR_PRUNE_BATCH = 20_000;

/**
 * Maximum response size read. An infinite stream served to a probe that runs
 * every minute exhausts the worker within hours.
 */
export const MONITOR_MAX_RESPONSE_BYTES = 256 * 1024;

/** Redirects followed. Each one is checked again by the SSRF policy. */
export const MONITOR_MAX_REDIRECTS = 5;

export const MONITOR_USER_AGENT = 'pupitre-monitor/1';

/** Sweep interval. Fixed: it is an execution detail, not a setting. */
export const MONITOR_SWEEP_EVERY_MS = 30_000;

/**
 * A sweep's working time. Well under the interval: a sweep that overflows simply
 * leaves the remaining probes to the next one, they are still due.
 */
export const MONITOR_SWEEP_BUDGET_MS = 22_000;

/** Probes run concurrently in a sweep. */
export const MONITOR_SWEEP_CONCURRENCY = 10;

/** Probes claimed at most per sweep. */
export const MONITOR_SWEEP_BATCH = 200;

/** Measurements shown in the list's compact curve. */
export const MONITOR_SPARKLINE_POINTS = 40;

// ─── state machine ────────────────────────────────────────────────────────────

/**
 * An **incident is a transition**, not a row of the time series.
 *
 * A blip — a measurement that fails then passes again — must trigger nothing:
 * it is the most frequent case, and fifty messages for a two-minute outage,
 * nobody reads them. Hence a confirmation threshold, adjustable per probe:
 * `failureThreshold` consecutive failures to open, `recoveryThreshold`
 * consecutive successes to close.
 *
 * The **confirmed** state (`status`) therefore only moves at transitions. The
 * last raw verdict is kept apart (`lastOutcome`), which lets the screen say "1
 * failure out of 3 — not confirmed" rather than lie one way or the other.
 */
export type MonitorState = {
  status: MonitorStatus;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  /**
   * Is an incident open? Usually, it is exactly "the confirmed state is an
   * outage". Not always: changing what a probe watches resets its state to
   * `unknown` — the verdict was about something else — without closing the
   * incident, which was announced. Without this field, the machine then believed
   * it had "nothing to close": the return to normal went unannounced, the incident
   * stayed open forever, and the unique index swallowed every following outage.
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

  // In an incident: the outage was confirmed and announced. The state says so
  // (`unhealthy`, `unreachable`), or it was reset to `unknown` by a target change
  // during the outage — the incident is still running.
  const inIncident =
    previous.incidentOpen || previous.status === 'unhealthy' || previous.status === 'unreachable';

  if (healthy) {
    // Outside an incident, a single healthy measurement is enough to show
    // "healthy": there is nothing to close, hence nothing to confirm. In an
    // incident, recovery needs its threshold — and it is announced, even if the
    // displayed state was `unknown`.
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
    // Already down: we update the nature of the failure without reopening an incident.
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
 * Why a probe was paused — **data**, not a sentence.
 *
 * ── The trap avoided ────────────────────────────────────────────────────────
 * `monitors.paused_reason` is a column: what is written there stays written.
 * Writing « application plus déployée — sonde suspendue automatiquement » froze
 * the language **at sweep time**, forever, and for every reader — including the
 * one who would switch the instance to English the following year. Translating
 * at write time is not translating, it is recording.
 *
 * ── Why a key, and not an enumeration ───────────────────────────────────────
 * The column stays free text, deliberately. Two reasons:
 *   • rows **already in the database** carry the old French sentence, and an
 *     enumeration would make them unreadable or require a migration that
 *     rewrites a past fact;
 *   • nothing forbids a human from writing their own reason there one day, and
 *     an enumeration would refuse it.
 *
 * Hence the contract: **automatic** reasons are written with the `auto:` prefix,
 * the screen recognizes them and renders them in its language, and **falls back
 * on the raw value** as soon as it does not recognize one. An old row therefore
 * shows as it was written, breaking nothing.
 */
export const MONITOR_PAUSE_ORPHANED = 'auto:orphaned';

const UNKNOWN_TYPE_PREFIX = 'auto:unknown-type:';

/** Reason for a probe whose type no longer exists in this version of the panel. */
export function monitorPauseUnknownType(type: string): string {
  return `${UNKNOWN_TYPE_PREFIX}${type}`;
}

export type MonitorPause =
  | { reason: 'orphaned' }
  | { reason: 'unknownType'; type: string }
  /** What the screen does not recognize: a row from before, or a free reason. */
  | { reason: 'free'; text: string };

export function parseMonitorPause(raw: string): MonitorPause {
  if (raw === MONITOR_PAUSE_ORPHANED) return { reason: 'orphaned' };
  if (raw.startsWith(UNKNOWN_TYPE_PREFIX)) {
    return { reason: 'unknownType', type: raw.slice(UNKNOWN_TYPE_PREFIX.length) };
  }
  return { reason: 'free', text: raw };
}

// ─── availability rate ────────────────────────────────────────────────────────

/**
 * A rate without its denominator means nothing: "100% over 3 measurements" is
 * not "100% over 1,440". The screen always shows both, and a window without any
 * measurement returns `null` — not 0%.
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
 * The words of durations, rates and alerts — and nothing but the words.
 *
 * These four formats show everywhere: under each probe card, in the detail's
 * banner, in the list of scheduled tasks. Leaving them hard-coded meant leaving
 * a French sentence on an English screen at every line. The `alert.*` entries
 * are not displayed: they go to Slack, Discord or a home-made receiver. It is
 * the same need — nobody is in front of the screen, so the language is the
 * instance's, and the worker passes it.
 *
 * Two keys carry a language divergence nothing else could absorb:
 * `cadence.every.masculine` and `cadence.every.feminine`. French agrees the
 * article with what follows — « toutes les minutes », « tous les jours » —
 * where English says *every* in both cases. The choice is therefore made on the
 * code's side, and English simply returns the same sentence twice.
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
 * Every format takes its language: the panel passes its screen's, the worker the
 * instance's.
 */
function copy(language: UiLanguage): StateTranslate {
  return translator(monitorStateCopy, language);
}

export function formatUptime(window: UptimeWindow, language: UiLanguage): string {
  const t = copy(language);
  if (window.ratio === null) return t('uptime.none');
  const percent = window.ratio * 100;
  // Two decimals under 100%: 99.93% and 99.99% are not the same outage. French's
  // decimal comma and English's point come from `Intl`, not from a manual
  // replacement.
  const text =
    percent === 100
      ? '100'
      : new Intl.NumberFormat(language, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(percent);
  return t('uptime.ratio', { percent: text, count: window.samples });
}

export function formatDuration(seconds: number, language: UiLanguage): string {
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

/** A duration, spelled out: "30 seconds", "6 hours", "1 day". */
export function formatInterval(seconds: number, language: UiLanguage): string {
  const t = copy(language);
  if (seconds < 60) return t('interval.seconds', { count: seconds });
  if (seconds % 86_400 === 0) return t('interval.days', { count: seconds / 86_400 });
  if (seconds % 3_600 === 0) return t('interval.hours', { count: seconds / 3_600 });
  return t('interval.minutes', { count: Math.round(seconds / 60) });
}

/**
 * The same duration, as a cadence: "every 30 seconds", "every day".
 *
 * A separate function because French does not compose: « toutes les » before a
 * minute, « tous les » before a day. Concatenating a duration after a frozen
 * « toutes les » produced « toutes les heure ».
 */
export function formatCadence(seconds: number, language: UiLanguage): string {
  const t = copy(language);
  if (seconds === 86_400) return t('cadence.daily');
  if (seconds === 3_600) return t('cadence.hourly');
  if (seconds === 60) return t('cadence.minutely');
  const interval = formatInterval(seconds, language);
  const masculine = seconds % 86_400 === 0 && seconds >= 86_400;
  return t(masculine ? 'cadence.every.masculine' : 'cadence.every.feminine', { interval });
}

// ─── alert ────────────────────────────────────────────────────────────────────

/**
 * An **outgoing webhook**, and nothing else for now. A POST request with a JSON
 * payload covers Slack, Discord, Teams and any home-made receiver with a single
 * mechanism. There is no mailer in this project, and adding one for this
 * feature would mean starting with the most expensive.
 *
 * The payload carries `text` **and** `content` on top of the structured body:
 * that is what Slack and Discord respectively read, so that a webhook pasted as
 * is shows a readable sentence without transformation.
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
    /** The target, in one line — a URL for HTTP, a host:port for TLS. */
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
 * The alert's sentence is rendered **here**, in the language it is given.
 *
 * It goes to channels, not to a screen: nobody is in front, so the language is
 * the instance's. The worker reads it from the settings and passes it.
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
  language: UiLanguage,
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
