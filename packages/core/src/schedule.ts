import { isValidTimeZone } from './settings.js';
import { translator, type Translate, type Translated, type UiLanguage } from './i18n.js';
import { z } from 'zod';

/**
 * Vocabulary of scheduled tasks, shared by the panel, the worker and the
 * database.
 *
 * ── Trade-off on `scheduled_job_type` ───────────────────────────────────────
 * The Postgres enum dates from the original schema and holds `scan |
 * healthcheck | preflight | cleanup`. Scheduling names the tasks
 * `scan:periodic`, `health:periodic`, `cleanup:versions`, `target:preflight`.
 * **The enum was not migrated**: its four values cover exactly the four tasks,
 * and migrating a Postgres enum for a cosmetic rename, on a table already
 * applied, costs a destructive migration for nothing.
 *
 * The BullMQ name therefore lives where it makes sense: in
 * `scheduled_jobs.key`, which *is* the job scheduler's identifier on the BullMQ
 * side. The type → task name mapping is this data table; there is no
 * `if (type === 'scan')` anywhere.
 */

export const SCHEDULED_JOB_TYPES_LIST = [
  'scan',
  'healthcheck',
  'cleanup',
  'preflight',
  'backup',
  'panel_backup',
] as const;

export const scheduledJobTypeSchema = z.enum(SCHEDULED_JOB_TYPES_LIST);
export type ScheduledJobType = z.infer<typeof scheduledJobTypeSchema>;

export type ScheduledJobDefinition = {
  /** Name of the BullMQ task produced by the scheduler. */
  jobName: string;
  /** BullMQ key offered by default at creation. */
  defaultKey: string;
  label: string;
  description: string;
  defaultCron: string;
  /** What the task does **not** do — shown in the UI, on purpose. */
  neverDoes: string;
};

/**
 * Scheduling's words — and nothing but the words.
 *
 * The BullMQ name, the default key and the cron expression do not come in
 * here: they are identifiers and data, not prose. What is displayed, on the
 * other hand, is all here, so that the table below no longer has a single
 * hard-coded sentence.
 */
const fr = {
  'job.scan.label': 'Scan périodique',
  'job.scan.description':
    'Relance les scanners configurés sur les applications déployées et rattache le ' +
    'rapport obtenu au déploiement courant.',
  'job.scan.neverDoes': 'Ne redéploie rien, ne bloque rien : une CRITICAL alerte, elle ne coupe pas.',

  'job.healthcheck.label': 'Healthcheck périodique',
  'job.healthcheck.description': 'Sonde les déploiements actifs et met à jour leur statut de santé.',
  'job.healthcheck.neverDoes': 'Ne déclenche aucun rollback : le statut informe, il ne décide pas.',

  'job.cleanup.label': 'Purge des versions',
  'job.cleanup.description':
    'Supprime sur les cibles les répertoires de version au-delà des 5 derniers.',
  'job.cleanup.neverDoes': 'Ne touche jamais à la version courante, ni à aucune ressource applicative.',

  'job.preflight.label': 'Rafraîchissement des cibles',
  'job.preflight.description': "Relance le preflight de toutes les cibles et rafraîchit leur état.",
  'job.preflight.neverDoes': 'Ne modifie aucune cible : elle ne fait que constater.',

  'job.backup.label': 'Sauvegardes des applications',
  'job.backup.description':
    'Sauvegarde chaque application dont la sauvegarde automatique est activée — export des ' +
    'bases reconnues, archive des volumes —, chiffrée, vers la destination configurée.',
  'job.backup.neverDoes':
    "N'arrête une application que si son mode « arrêt bref » le demande ; ne restaure jamais rien.",

  'job.panel_backup.label': 'Sauvegarde du panel',
  'job.panel_backup.description':
    'Exporte la base de Pupitre (pg_dump), la chiffre et la dépose sur la destination configurée.',
  'job.panel_backup.neverDoes':
    'Ne sauvegarde pas MASTER_KEY : sans elle, aucune sauvegarde ne se relit. Gardez-la ailleurs.',

  // ── Fields of a cron expression, named for a human ─────────────────────
  // A field's *key* stays English and serves the logic (month aliases, day
  // aliases); only this label is displayed.
  'cron.field.second': 'seconde',
  'cron.field.minute': 'minute',
  'cron.field.hour': 'heure',
  'cron.field.dayOfMonth': 'jour du mois',
  'cron.field.month': 'mois',
  'cron.field.weekday': 'jour de la semaine',

  'cron.error.fieldCount': 'une expression cron compte 5 ou 6 champs, celle-ci en a {count}',
  'cron.error.missing': 'champ « {field} » manquant',
  'cron.error.emptyItem': 'champ « {field} » : élément vide',
  'cron.error.badItem': 'champ « {field} » : pas « {item} » mal formé',
  'cron.error.badStep': 'champ « {field} » : pas « /{step} » invalide',
  'cron.error.badRange': 'champ « {field} » : plage « {range} » mal formée',
  'cron.error.outOfBounds': 'champ « {field} » : « {token} » hors de {min}-{max}',
} as const;

const en: Translated<typeof fr> = {
  'job.scan.label': 'Periodic scan',
  'job.scan.description':
    'Runs the scanners configured on deployed applications again and attaches the report to the current deployment.',
  'job.scan.neverDoes': 'Redeploys nothing, blocks nothing: a CRITICAL alerts, it does not cut.',

  'job.healthcheck.label': 'Periodic healthcheck',
  'job.healthcheck.description': 'Probes live deployments and updates their health status.',
  'job.healthcheck.neverDoes': 'Triggers no rollback: the status informs, it does not decide.',

  'job.cleanup.label': 'Version purge',
  'job.cleanup.description': 'Deletes version directories on the targets beyond the 5 most recent.',
  'job.cleanup.neverDoes': 'Never touches the current version, nor any application resource.',

  'job.preflight.label': 'Target refresh',
  'job.preflight.description': 'Runs preflight on every target again and refreshes their state.',
  'job.preflight.neverDoes': 'Changes no target: it only observes.',

  'job.backup.label': 'Application backups',
  'job.backup.description':
    'Backs up every application with automatic backup enabled — export of recognized ' +
    'databases, archive of volumes —, encrypted, to the configured destination.',
  'job.backup.neverDoes':
    'Stops an application only if its “brief stop” mode asks for it; never restores anything.',

  'job.panel_backup.label': 'Panel backup',
  'job.panel_backup.description':
    'Exports the Pupitre database (pg_dump), encrypts it and stores it on the configured destination.',
  'job.panel_backup.neverDoes':
    'Does not back up MASTER_KEY: without it, no backup can be read. Keep it elsewhere.',

  'cron.field.second': 'second',
  'cron.field.minute': 'minute',
  'cron.field.hour': 'hour',
  'cron.field.dayOfMonth': 'day of month',
  'cron.field.month': 'month',
  'cron.field.weekday': 'day of week',

  'cron.error.fieldCount': 'a cron expression has 5 or 6 fields, this one has {count}',
  'cron.error.missing': 'field “{field}” missing',
  'cron.error.emptyItem': 'field “{field}”: empty item',
  'cron.error.badItem': 'field “{field}”: malformed step “{item}”',
  'cron.error.badStep': 'field “{field}”: invalid step “/{step}”',
  'cron.error.badRange': 'field “{field}”: malformed range “{range}”',
  'cron.error.outOfBounds': 'field “{field}”: “{token}” outside {min}-{max}',
};

export const scheduleCopy = { fr, en };

type ScheduleTranslate = Translate<typeof fr>;

/**
 * A single table. Adding a scheduled task = adding an entry here and a handler
 * in the worker; no other line of the project changes.
 */
function buildScheduledJobTypes(
  t: ScheduleTranslate,
): Record<ScheduledJobType, ScheduledJobDefinition> {
  return {
    scan: {
      jobName: 'scan:periodic',
      defaultKey: 'scan:periodic',
      label: t('job.scan.label'),
      description: t('job.scan.description'),
      defaultCron: '0 4 * * *',
      neverDoes: t('job.scan.neverDoes'),
    },
    healthcheck: {
      jobName: 'health:periodic',
      defaultKey: 'health:periodic',
      label: t('job.healthcheck.label'),
      description: t('job.healthcheck.description'),
      defaultCron: '*/5 * * * *',
      neverDoes: t('job.healthcheck.neverDoes'),
    },
    cleanup: {
      jobName: 'cleanup:versions',
      defaultKey: 'cleanup:versions',
      label: t('job.cleanup.label'),
      description: t('job.cleanup.description'),
      defaultCron: '30 3 * * *',
      neverDoes: t('job.cleanup.neverDoes'),
    },
    preflight: {
      // A name deliberately distinct from the manual preflight's `target:preflight`
      // task, which takes ONE target and opens an SSH session. This one sweeps every
      // target and enqueues one `target:preflight` per target: it reuses the existing
      // handler instead of duplicating its logic.
      jobName: 'target:preflight:all',
      defaultKey: 'target:preflight',
      label: t('job.preflight.label'),
      description: t('job.preflight.description'),
      defaultCron: '0 * * * *',
      neverDoes: t('job.preflight.neverDoes'),
    },
    backup: {
      // The scheduled task only enqueues one backup per application, on the `backups`
      // queue: it returns within a second.
      jobName: 'backup:schedule',
      defaultKey: 'backup:applications',
      label: t('job.backup.label'),
      description: t('job.backup.description'),
      defaultCron: '0 2 * * *',
      neverDoes: t('job.backup.neverDoes'),
    },
    panel_backup: {
      jobName: 'backup:schedule-panel',
      defaultKey: 'backup:panel',
      label: t('job.panel_backup.label'),
      description: t('job.panel_backup.description'),
      defaultCron: '30 1 * * *',
      neverDoes: t('job.panel_backup.neverDoes'),
    },
  };
}

const TABLES = new Map<UiLanguage, Record<ScheduledJobType, ScheduledJobDefinition>>();

/**
 * The table in one language. Memoized: one table per language actually
 * requested, built once, never at each render.
 */
export function scheduledJobTypes(
  language: UiLanguage = 'fr',
): Record<ScheduledJobType, ScheduledJobDefinition> {
  const cached = TABLES.get(language);
  if (cached) return cached;
  const built = buildScheduledJobTypes(translator(scheduleCopy, language));
  TABLES.set(language, built);
  return built;
}

/**
 * The table in French. Kept for callers that have no language to offer — the
 * worker, the database — and that only read `jobName` and `defaultKey` from it
 * anyway.
 */
export const SCHEDULED_JOB_TYPES: Record<ScheduledJobType, ScheduledJobDefinition> =
  scheduledJobTypes('fr');

export const SCHEDULED_JOB_NAMES: readonly string[] = SCHEDULED_JOB_TYPES_LIST.map(
  (type) => SCHEDULED_JOB_TYPES[type].jobName,
);

/** Data carried by every task coming from the scheduler. */
export const scheduledJobDataSchema = z.object({
  scheduledJobId: z.string().uuid(),
  type: scheduledJobTypeSchema,
  key: z.string().min(1).max(120),
  payload: z.record(z.string(), z.unknown()).default({}),
  /** Filled in for a manual trigger from the UI. */
  actorId: z.string().min(1).nullable().default(null),
  ip: z.string().min(1).nullable().default(null),
  manual: z.boolean().default(false),
});

export type ScheduledJobData = z.infer<typeof scheduledJobDataSchema>;

export const scheduledJobResultSchema = z.object({
  scheduledJobId: z.string().uuid(),
  type: scheduledJobTypeSchema,
  status: z.enum(['success', 'failed', 'skipped']),
  summary: z.record(z.string(), z.unknown()),
});

export type ScheduledJobResult = z.infer<typeof scheduledJobResultSchema>;

// ─── cron expressions ─────────────────────────────────────────────────────────

/**
 * Validation of a 5- or 6-field cron expression.
 *
 * Written here rather than delegated to `cron-parser`: that package is only a
 * transitive dependency of BullMQ for us, and relying on it would mean
 * depending on another library's implementation detail. The panel must be able
 * to refuse an invalid expression **before** writing it to the database.
 */
type CronBound = {
  /** Logic and label key. Never displayed bare. */
  key: 'second' | 'minute' | 'hour' | 'dayOfMonth' | 'month' | 'weekday';
  min: number;
  max: number;
};

const CRON_FIELD_BOUNDS: readonly CronBound[] = [
  { key: 'minute', min: 0, max: 59 },
  { key: 'hour', min: 0, max: 23 },
  { key: 'dayOfMonth', min: 1, max: 31 },
  { key: 'month', min: 1, max: 12 },
  { key: 'weekday', min: 0, max: 7 },
];

const SECONDS_BOUND: CronBound = { key: 'second', min: 0, max: 59 };

const MONTH_ALIASES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_ALIASES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function aliasesFor(key: CronBound['key']): string[] {
  if (key === 'month') return MONTH_ALIASES;
  if (key === 'weekday') return DAY_ALIASES;
  return [];
}

function validateField(raw: string, bound: CronBound, t: ScheduleTranslate): string | null {
  const aliases = aliasesFor(bound.key);
  const field = t(`cron.field.${bound.key}`);

  const readValue = (token: string): number | null => {
    const lower = token.toLowerCase();
    const aliasIndex = aliases.indexOf(lower);
    if (aliasIndex >= 0) return bound.key === 'month' ? aliasIndex + 1 : aliasIndex;
    if (!/^\d+$/.test(token)) return null;
    const value = Number(token);
    return value >= bound.min && value <= bound.max ? value : null;
  };

  for (const part of raw.split(',')) {
    if (part.length === 0) return t('cron.error.emptyItem', { field });

    const [range, step, ...extra] = part.split('/');
    if (extra.length > 0 || range === undefined) {
      return t('cron.error.badItem', { field, item: part });
    }
    if (step !== undefined && (!/^\d+$/.test(step) || Number(step) === 0)) {
      return t('cron.error.badStep', { field, step });
    }

    if (range === '*') continue;

    const bounds = range.split('-');
    if (bounds.length > 2) return t('cron.error.badRange', { field, range });
    for (const token of bounds) {
      if (readValue(token) === null) {
        return t('cron.error.outOfBounds', { field, token, min: bound.min, max: bound.max });
      }
    }
  }

  return null;
}

/**
 * `null` if the expression is valid, otherwise the reason for the refusal.
 *
 * The reason shows under the input field: it is therefore rendered in the
 * language it is given. The default stays French, for `cronSchema` — a Zod
 * message travels in `details`, which the panel does not show.
 */
export function cronError(expression: string, language: UiLanguage = 'fr'): string | null {
  const t = translator(scheduleCopy, language);
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) {
    return t('cron.error.fieldCount', { count: fields.length });
  }

  const bounds =
    fields.length === 6 ? [SECONDS_BOUND, ...CRON_FIELD_BOUNDS] : [...CRON_FIELD_BOUNDS];

  for (const [index, bound] of bounds.entries()) {
    const field = fields[index];
    if (field === undefined) {
      return t('cron.error.missing', { field: t(`cron.field.${bound.key}`) });
    }
    const error = validateField(field, bound, t);
    if (error) return error;
  }
  return null;
}

export const cronSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .superRefine((value, ctx) => {
    const error = cronError(value);
    if (error) ctx.addIssue({ code: 'custom', message: error });
  });


// ─── simplified schedule ──────────────────────────────────────────────────────

/**
 * A schedule expressed without writing cron.
 *
 * It is an **input layer**, not a second storage format. Nothing of this union
 * is written to the database: what is persisted and what BullMQ consumes stays
 * the cron expression produced by `toCron()`. Two persisted truths would end up
 * diverging; this one does not outlive the HTTP request.
 *
 * `toCron()` and `fromCron()` are inverses:
 *   `toCron(fromCron(e)) === e`  for every expression `fromCron` accepts
 *   `fromCron(toCron(s))` equals `s`  for every valid `SimpleSchedule`
 * `scripts/test-schedule.ts` checks both directions.
 */

/** The only intervals offered: beyond them, a cron says the thing more clearly. */
export const SIMPLE_INTERVAL_MINUTES = [5, 10, 15, 30] as const;

export type SimpleIntervalMinutes = (typeof SIMPLE_INTERVAL_MINUTES)[number];

const minuteField = z.number().int().min(0).max(59);
const hourField = z.number().int().min(0).max(23);

export const simpleScheduleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('interval'),
    everyMinutes: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(30)]),
  }),
  z.object({ kind: z.literal('hourly'), minute: minuteField }),
  z.object({ kind: z.literal('daily'), hour: hourField, minute: minuteField }),
  z.object({
    kind: z.literal('weekly'),
    // 0 = Sunday, like cron. Several days possible, at least one.
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    hour: hourField,
    minute: minuteField,
  }),
  z.object({
    kind: z.literal('monthly'),
    // 29 to 31 are accepted because cron accepts them: months that are too short are
    // then skipped. The UI says so; we do not rewrite the operator's choice.
    day: z.number().int().min(1).max(31),
    hour: hourField,
    minute: minuteField,
  }),
]);

export type SimpleSchedule = z.infer<typeof simpleScheduleSchema>;
export type SimpleScheduleKind = SimpleSchedule['kind'];

export const SIMPLE_SCHEDULE_KINDS: readonly SimpleScheduleKind[] = [
  'interval',
  'hourly',
  'daily',
  'weekly',
  'monthly',
];

/** Simplified schedule → 5-field cron expression. Always valid. */
export function toCron(simple: SimpleSchedule): string {
  switch (simple.kind) {
    case 'interval':
      return `*/${simple.everyMinutes} * * * *`;
    case 'hourly':
      return `${simple.minute} * * * *`;
    case 'daily':
      return `${simple.minute} ${simple.hour} * * *`;
    case 'weekly': {
      const days = [...new Set(simple.weekdays)].sort((a, b) => a - b).join(',');
      return `${simple.minute} ${simple.hour} * * ${days}`;
    }
    case 'monthly':
      return `${simple.minute} ${simple.hour} ${simple.day} * *`;
  }
}

/** A bare integer — no range, no step, no list. */
function plainInt(token: string, min: number, max: number): number | null {
  if (!/^\d{1,2}$/.test(token)) return null;
  const value = Number(token);
  return value >= min && value <= max ? value : null;
}

/** A bare weekday: digit 0-7 (7 = Sunday) or three-letter alias. */
function plainWeekday(token: string): number | null {
  const alias = DAY_ALIASES.indexOf(token.toLowerCase());
  if (alias >= 0) return alias;
  const value = plainInt(token, 0, 7);
  return value === null ? null : value % 7;
}

/**
 * Cron expression → simplified schedule, or `null`.
 *
 * **All or nothing.** We do not approximate, we do not guess: an expression
 * without an *exact* equivalent in the union returns `null`, and the screen
 * switches to expert mode rather than showing a wrong schedule.
 *
 * Accepted:
 *   `*&#47;N * * * *`  with N ∈ {5, 10, 15, 30}            → interval
 *   `M * * * *`        M integer                           → hourly
 *   `M H * * *`        M and H integers                    → daily
 *   `M H * * d[,d…]`   bare days (0-7 or `sun`…`sat`)      → weekly
 *   `M H D * *`        D integer 1-31                      → monthly
 *
 * Refused — deliberately: any range (`2-5`), any step outside the minute field
 * (`*&#47;3` in hours), any restricted month, any combination of day of month
 * **and** day of week (cron treats them as OR, no `kind` says so), `*` in
 * minutes, and more generally any form not listed above.
 *
 * A six-field expression is only accepted if the seconds field is exactly `0`:
 * `0 30 3 * * *` is then *strictly* equivalent to `30 3 * * *`. It is not an
 * approximation, it is the same thing; going back through `toCron()` produces
 * the five-field form.
 */
export function fromCron(expression: string): SimpleSchedule | null {
  if (cronError(expression) !== null) return null;

  let fields = expression.trim().split(/\s+/);
  if (fields.length === 6) {
    if (fields[0] !== '0') return null;
    fields = fields.slice(1);
  }
  if (fields.length !== 5) return null;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  // A restricted month has no simple equivalent: we stop there.
  if (month !== '*') return null;

  // interval : `*/N * * * *`
  const step = /^\*\/(\d{1,2})$/.exec(minute)?.[1];
  if (step !== undefined) {
    if (hour !== '*' || dayOfMonth !== '*' || dayOfWeek !== '*') return null;
    const everyMinutes = Number(step);
    const known = SIMPLE_INTERVAL_MINUTES.find((value) => value === everyMinutes);
    return known === undefined ? null : { kind: 'interval', everyMinutes: known };
  }

  const min = plainInt(minute, 0, 59);
  if (min === null) return null;

  // hourly : `M * * * *`
  if (hour === '*') {
    if (dayOfMonth !== '*' || dayOfWeek !== '*') return null;
    return { kind: 'hourly', minute: min };
  }

  const hr = plainInt(hour, 0, 23);
  if (hr === null) return null;

  // monthly : `M H D * *`
  if (dayOfMonth !== '*') {
    if (dayOfWeek !== '*') return null;
    const day = plainInt(dayOfMonth, 1, 31);
    return day === null ? null : { kind: 'monthly', day, hour: hr, minute: min };
  }

  // daily : `M H * * *`
  if (dayOfWeek === '*') return { kind: 'daily', hour: hr, minute: min };

  // weekly : `M H * * d[,d…]`
  const weekdays: number[] = [];
  for (const token of dayOfWeek.split(',')) {
    const day = plainWeekday(token);
    if (day === null) return null;
    if (!weekdays.includes(day)) weekdays.push(day);
  }
  if (weekdays.length === 0) return null;
  weekdays.sort((a, b) => a - b);
  return { kind: 'weekly', weekdays, hour: hr, minute: min };
}

// ─── time zone ────────────────────────────────────────────────────────────────

/**
 * Time zone of a scheduled task.
 *
 * The time zone is **not** the scheduling process's: it is carried by the task
 * (`scheduled_jobs.timezone`) and passed to BullMQ as `{ pattern, tz }`, from
 * the panel as from the worker. Without this option, cron-parser fell back on
 * the process's time zone — UTC in our containers — and a task set "at 3 am"
 * ran at 05:00 in Paris in summer.
 *
 * The validator is the instance settings' one: a single judge of what an IANA
 * time zone is — `Intl`, hence the ICU actually embedded — and not a second
 * list that would diverge from the first.
 */
export const scheduleTimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, { message: 'Fuseau horaire IANA inconnu' });

/**
 * Time zone of tasks older than the `timezone` column.
 *
 * `UTC`, and above all not the instance's time zone: those tasks were installed
 * while BullMQ interpreted their pattern in the process's time zone, that is,
 * in UTC. Retroactively applying `Europe/Paris` to them would move by two hours
 * the execution of a task nobody asked to change. Migration `0009` therefore
 * sets this value on the existing ones; the instance's time zone is only the
 * default of tasks created afterwards.
 */
export const LEGACY_SCHEDULE_TIMEZONE = 'UTC';

/**
 * Time zone of the browser looking — never of the one scheduling.
 *
 * Only used to show, next to the task's time, what it gives on the reader's
 * clock when the two time zones differ.
 */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// ─── readable description ─────────────────────────────────────────────────────

export type CronLocale = 'fr' | 'en';

export type DescribeCronOptions = {
  locale?: CronLocale | string;
  /** Shown next to the time. It is the task's. */
  timeZone?: string;
};

type Words = {
  everyMinute: string;
  everyNMinutes: (n: number) => string;
  hourlyOnTheHour: string;
  hourlyAtMinute: (m: number) => string;
  daily: (at: string) => string;
  weekly: (days: string, at: string) => string;
  monthly: (day: number, at: string) => string;
  atMinutes: (list: string) => string;
  atHours: (list: string) => string;
  atClockTimes: (list: string) => string;
  betweenHours: (from: number, to: number) => string;
  onDaysOfMonth: (list: string) => string;
  inMonths: (list: string) => string;
  onWeekdays: (list: string) => string;
  or: string;
  and: string;
  weekdayNames: readonly string[];
  monthNames: readonly string[];
  everyDayOfWeek: string;
};

const WORDS: Record<CronLocale, Words> = {
  fr: {
    everyMinute: 'chaque minute',
    everyNMinutes: (n) => `toutes les ${n} minutes`,
    hourlyOnTheHour: 'toutes les heures, à l’heure pile',
    hourlyAtMinute: (m) => `toutes les heures, à la minute ${m}`,
    daily: (at) => `tous les jours à ${at}`,
    weekly: (days, at) => `${days} à ${at}`,
    monthly: (day, at) => `le ${day === 1 ? '1er' : day} de chaque mois à ${at}`,
    atMinutes: (list) => `aux minutes ${list}`,
    atHours: (list) => `à ${list} h`,
    atClockTimes: (list) => `à ${list}`,
    betweenHours: (from, to) => `entre ${from} h et ${to} h 59`,
    onDaysOfMonth: (list) => `le${list.includes(',') || list.includes(' et ') ? 's' : ''} ${list} du mois`,
    inMonths: (list) => `en ${list}`,
    onWeekdays: (list) => `les ${list}`,
    or: 'ou',
    and: 'et',
    weekdayNames: ['dimanches', 'lundis', 'mardis', 'mercredis', 'jeudis', 'vendredis', 'samedis'],
    monthNames: [
      'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
      'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
    ],
    everyDayOfWeek: 'tous les jours',
  },
  en: {
    everyMinute: 'every minute',
    everyNMinutes: (n) => `every ${n} minutes`,
    hourlyOnTheHour: 'every hour, on the hour',
    hourlyAtMinute: (m) => `every hour at minute ${m}`,
    daily: (at) => `every day at ${at}`,
    weekly: (days, at) => `${days} at ${at}`,
    monthly: (day, at) => `on day ${day} of every month at ${at}`,
    atMinutes: (list) => `at minutes ${list}`,
    atHours: (list) => `at ${list} o’clock`,
    atClockTimes: (list) => `at ${list}`,
    betweenHours: (from, to) => `between ${from}:00 and ${to}:59`,
    onDaysOfMonth: (list) => `on days ${list} of the month`,
    inMonths: (list) => `in ${list}`,
    onWeekdays: (list) => `on ${list}`,
    or: 'or',
    and: 'and',
    weekdayNames: ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'],
    monthNames: [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ],
    everyDayOfWeek: 'every day',
  },
};

function wordsFor(locale: CronLocale | string | undefined): Words {
  const key = (locale ?? 'fr').slice(0, 2).toLowerCase();
  return key === 'en' ? WORDS.en : WORDS.fr;
}

function joinList(items: readonly string[], conjunction: string): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] as string;
  return `${items.slice(0, -1).join(', ')} ${conjunction} ${items[items.length - 1] as string}`;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/**
 * Readable description of a cron expression.
 *
 * It works for **any** valid expression, including those `fromCron()` rejects:
 * in that case it describes field by field what the expression really says,
 * without rounding. An invalid expression, or a form we cannot put into words,
 * is returned as is — a wrong description would be worse than no description.
 */
export function describeCron(expression: string, options: DescribeCronOptions = {}): string {
  const words = wordsFor(options.locale);
  const suffix = options.timeZone ? ` (${options.timeZone})` : '';

  const simple = fromCron(expression);
  if (simple) {
    switch (simple.kind) {
      case 'interval':
        // An interval in minutes depends on no time zone: no suffix.
        return words.everyNMinutes(simple.everyMinutes);
      case 'hourly':
        return simple.minute === 0
          ? words.hourlyOnTheHour
          : words.hourlyAtMinute(simple.minute);
      case 'daily':
        return words.daily(`${pad2(simple.hour)}:${pad2(simple.minute)}`) + suffix;
      case 'weekly': {
        const days =
          simple.weekdays.length === 7
            ? words.everyDayOfWeek
            : words.onWeekdays(
                joinList(
                  simple.weekdays.map((day) => words.weekdayNames[day] as string),
                  words.and,
                ),
              );
        return words.weekly(days, `${pad2(simple.hour)}:${pad2(simple.minute)}`) + suffix;
      }
      case 'monthly':
        return (
          words.monthly(simple.day, `${pad2(simple.hour)}:${pad2(simple.minute)}`) + suffix
        );
    }
  }

  const parsed = parseCronFields(expression);
  if (!parsed) return expression;

  const parts: string[] = [];
  const { minutes, hours, daysOfMonth, months, daysOfWeek, restricted } = parsed;

  const minuteStep = /^\*\/(\d{1,2})$/.exec(parsed.raw.minute)?.[1];
  const minuteList = sorted(minutes);
  const hourList = sorted(hours);

  // A single minute and enumerated hours read as full hours — "at 00:00, 03:00,
  // 06:00" rather than "at minutes 0, at 0, 3, 6 h".
  const singleMinute = parsed.raw.minute !== '*' && minuteStep === undefined && minuteList.length === 1;
  if (singleMinute && restricted.hours) {
    const clocks = capList(hourList).map((hour) =>
      typeof hour === 'number' ? `${pad2(hour)}:${pad2(minuteList[0] as number)}` : hour,
    );
    parts.push(words.atClockTimes(joinList(clocks.map(String), words.and)));
  } else {
    // Minutes.
    if (parsed.raw.minute === '*') parts.push(words.everyMinute);
    else if (minuteStep !== undefined) parts.push(words.everyNMinutes(Number(minuteStep)));
    else parts.push(words.atMinutes(joinList(minuteList.map(String), words.and)));

    // Heures.
    if (restricted.hours) {
      const contiguous =
        hourList.length > 1 &&
        (hourList[hourList.length - 1] as number) - (hourList[0] as number) === hourList.length - 1;
      parts.push(
        contiguous
          ? words.betweenHours(hourList[0] as number, hourList[hourList.length - 1] as number)
          : words.atHours(joinList(capList(hourList).map(String), words.and)),
      );
    }
  }

  // Day of month and day of week: cron combines them as OR as soon as both are
  // restricted. Saying it otherwise would be wrong.
  const dayParts: string[] = [];
  if (restricted.daysOfMonth) {
    dayParts.push(words.onDaysOfMonth(joinList(capList(sorted(daysOfMonth)).map(String), words.and)));
  }
  if (restricted.daysOfWeek) {
    dayParts.push(
      words.onWeekdays(
        joinList(
          sorted(daysOfWeek).map((day) => words.weekdayNames[day] as string),
          words.and,
        ),
      ),
    );
  }
  if (dayParts.length > 0) parts.push(dayParts.join(` ${words.or} `));

  if (restricted.months) {
    parts.push(
      words.inMonths(
        joinList(
          sorted(months).map((month) => words.monthNames[month - 1] as string),
          words.and,
        ),
      ),
    );
  }

  const hasClock = restricted.hours;
  return parts.join(', ') + (hasClock ? suffix : '');
}

function sorted(values: ReadonlySet<number>): number[] {
  return [...values].sort((a, b) => a - b);
}

/** An enumeration of twenty values teaches nothing: we cap it. */
function capList(values: readonly number[]): (number | string)[] {
  return values.length <= 8 ? [...values] : [...values.slice(0, 8), '…'];
}

// ─── next occurrences ─────────────────────────────────────────────────────────

type CronFields = {
  raw: { second: string; minute: string; hour: string; dayOfMonth: string; month: string; dayOfWeek: string };
  seconds: Set<number>;
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  restricted: { hours: boolean; daysOfMonth: boolean; months: boolean; daysOfWeek: boolean };
};

function expandField(
  raw: string,
  min: number,
  max: number,
  aliases: readonly string[],
  aliasOffset: number,
): Set<number> | null {
  const out = new Set<number>();

  const read = (token: string): number | null => {
    const alias = aliases.indexOf(token.toLowerCase());
    if (alias >= 0) return alias + aliasOffset;
    if (!/^\d{1,2}$/.test(token)) return null;
    const value = Number(token);
    return value >= min && value <= max ? value : null;
  };

  for (const part of raw.split(',')) {
    const [range, stepRaw, ...extra] = part.split('/');
    if (extra.length > 0 || range === undefined) return null;
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) return null;

    let from: number;
    let to: number;
    if (range === '*') {
      from = min;
      to = max;
    } else {
      const bounds = range.split('-');
      const start = read(bounds[0] ?? '');
      if (start === null) return null;
      if (bounds.length === 1) {
        from = start;
        // `5/10` means "from 5, every 10"; `5` alone, just 5.
        to = stepRaw === undefined ? start : max;
      } else if (bounds.length === 2) {
        const end = read(bounds[1] ?? '');
        if (end === null || end < start) return null;
        from = start;
        to = end;
      } else {
        return null;
      }
    }

    for (let value = from; value <= to; value += step) out.add(value);
  }

  return out.size === 0 ? null : out;
}

/** Fields of a cron expression, expanded into sets of values. */
function parseCronFields(expression: string): CronFields | null {
  if (cronError(expression) !== null) return null;
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return null;

  const [second, minute, hour, dayOfMonth, month, dayOfWeek] =
    fields.length === 6
      ? (fields as [string, string, string, string, string, string])
      : (['0', ...(fields as [string, string, string, string, string])] as [
          string,
          string,
          string,
          string,
          string,
          string,
        ]);

  const seconds = expandField(second, 0, 59, [], 0);
  const minutes = expandField(minute, 0, 59, [], 0);
  const hours = expandField(hour, 0, 23, [], 0);
  const daysOfMonth = expandField(dayOfMonth, 1, 31, [], 0);
  const months = expandField(month, 1, 12, MONTH_ALIASES, 1);
  const rawDaysOfWeek = expandField(dayOfWeek, 0, 7, DAY_ALIASES, 0);
  if (!seconds || !minutes || !hours || !daysOfMonth || !months || !rawDaysOfWeek) return null;

  // 7 and 0 both designate Sunday.
  const daysOfWeek = new Set([...rawDaysOfWeek].map((day) => day % 7));

  return {
    raw: { second, minute, hour, dayOfMonth, month, dayOfWeek },
    seconds,
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    restricted: {
      hours: hour !== '*',
      daysOfMonth: dayOfMonth !== '*',
      months: month !== '*',
      daysOfWeek: dayOfWeek !== '*',
    },
  };
}

/** Time fields of an instant, read in a given time zone. */
export function wallClockOf(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs));

  const read = (type: string): number => {
    const found = parts.find((part) => part.type === type)?.value;
    return found === undefined ? 0 : Number(found);
  };

  return Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour'),
    read('minute'),
    read('second'),
  );
}

/** Real instant matching a given wall-clock time in a time zone. */
export function instantOfWallClock(wallMs: number, timeZone: string): number {
  let guess = wallMs - (wallClockOf(wallMs, timeZone) - wallMs);
  // A single retry is enough: the correction never exceeds a DST offset.
  guess = wallMs - (wallClockOf(guess, timeZone) - guess);
  return guess;
}

export type NextRunsOptions = {
  from?: Date;
  count?: number;
  /** Time zone in which the expression is interpreted — the task's. */
  timeZone?: string;
  /** Beyond this, we give up rather than sweep forever. */
  horizonDays?: number;
};

/**
 * Next occurrences of a cron expression, in a given time zone.
 *
 * Used **only** for the form's preview: for a task already installed, the next
 * occurrence shown stays the one BullMQ computed, otherwise two independent
 * computations would end up no longer saying the same thing. Here there is
 * nothing in Redis to query — the expression is not saved yet.
 *
 * Returns an empty array if the expression is invalid or if no occurrence falls
 * within the horizon (a `0 0 29 2 *` has nothing to say for three years).
 */
export function nextRuns(expression: string, options: NextRunsOptions = {}): Date[] {
  const parsed = parseCronFields(expression);
  if (!parsed) return [];

  const count = options.count ?? 3;
  const horizonDays = options.horizonDays ?? 366;
  const from = options.from ?? new Date();
  const timeZone = safeTimeZone(options.timeZone);

  const minutes = sorted(parsed.minutes);
  const hours = sorted(parsed.hours);
  const second = Math.min(...parsed.seconds);

  const fromMs = from.getTime();
  const startWall = wallClockOf(fromMs, timeZone);
  // We start from the next minute: "now" is not an upcoming occurrence.
  const dayWall = Math.floor(startWall / 86_400_000) * 86_400_000;

  const out: Date[] = [];

  for (let dayIndex = 0; dayIndex <= horizonDays && out.length < count; dayIndex += 1) {
    const day = new Date(dayWall + dayIndex * 86_400_000);
    if (!matchesDay(day, parsed)) continue;

    for (const hour of hours) {
      for (const minute of minutes) {
        const wall =
          dayWall + dayIndex * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1000;
        const instant = instantOfWallClock(wall, timeZone);
        if (instant <= fromMs) continue;
        // A slot swallowed by a summer-time jump does not exist: we skip it.
        if (wallClockOf(instant, timeZone) !== wall) continue;
        out.push(new Date(instant));
        if (out.length >= count) break;
      }
      if (out.length >= count) break;
    }
  }

  return out.sort((a, b) => a.getTime() - b.getTime()).slice(0, count);
}

function matchesDay(dayWall: Date, parsed: CronFields): boolean {
  if (!parsed.months.has(dayWall.getUTCMonth() + 1)) return false;

  const domMatches = parsed.daysOfMonth.has(dayWall.getUTCDate());
  const dowMatches = parsed.daysOfWeek.has(dayWall.getUTCDay());

  // Historical cron semantics: when both fields are restricted, a day matches if
  // it satisfies one **or** the other.
  if (parsed.restricted.daysOfMonth && parsed.restricted.daysOfWeek) {
    return domMatches || dowMatches;
  }
  if (parsed.restricted.daysOfMonth) return domMatches;
  if (parsed.restricted.daysOfWeek) return dowMatches;
  return true;
}

function safeTimeZone(timeZone: string | undefined): string {
  if (!timeZone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}
