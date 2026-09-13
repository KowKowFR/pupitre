import { isValidTimeZone } from './settings.js';
import { translator, type Translate, type Translated, type UiLanguage } from './i18n.js';
import { z } from 'zod';

/**
 * Vocabulaire des tâches planifiées, partagé par le panel, le worker et la base.
 *
 * ── Arbitrage sur `scheduled_job_type` ───────────────────────────────────────
 * L'enum Postgres date du schéma d'origine et vaut `scan | healthcheck | preflight |
 * cleanup`. L'ordonnancement, lui, nomme les tâches `scan:periodic`,
 * `health:periodic`, `cleanup:versions`, `target:preflight`. **L'enum n'a pas
 * été migrée** : ses quatre valeurs recouvrent exactement les quatre tâches, et
 * migrer une enum Postgres pour un renommage cosmétique, sur une table déjà
 * appliquée, coûte une migration destructive sans rien apporter.
 *
 * Le nom BullMQ vit donc là où il a du sens : dans `scheduled_jobs.key`, qui
 * *est* l'identifiant du job scheduler côté BullMQ. La correspondance
 * type → nom de tâche est cette table de données ; il n'existe nulle part de
 * `if (type === 'scan')`.
 */

export const SCHEDULED_JOB_TYPES_LIST = [
  'scan',
  'healthcheck',
  'cleanup',
  'preflight',
] as const;

export const scheduledJobTypeSchema = z.enum(SCHEDULED_JOB_TYPES_LIST);
export type ScheduledJobType = z.infer<typeof scheduledJobTypeSchema>;

export type ScheduledJobDefinition = {
  /** Nom de la tâche BullMQ produite par le scheduler. */
  jobName: string;
  /** Clé BullMQ proposée par défaut à la création. */
  defaultKey: string;
  label: string;
  description: string;
  defaultCron: string;
  /** Ce que la tâche ne fait **pas** — affiché dans l'UI, à dessein. */
  neverDoes: string;
};

/**
 * Les mots de l'ordonnancement — et rien que les mots.
 *
 * Le nom BullMQ, la clé par défaut et l'expression cron n'entrent pas ici :
 * ce sont des identifiants et des données, pas de la prose. Ce qui s'affiche,
 * en revanche, y est en entier, de sorte que la table ci-dessous n'a plus une
 * seule phrase écrite en dur.
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

  // ── Champs d'une expression cron, nommés pour un humain ─────────────────
  // La *clé* d'un champ reste anglaise et sert à la logique (alias de mois,
  // alias de jour) ; seul ce libellé-ci s'affiche.
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
 * Une seule table. Ajouter une tâche planifiée = ajouter une entrée ici et un
 * handler dans le worker ; aucune autre ligne du projet ne change.
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
      // Nom volontairement distinct de la tâche `target:preflight` du preflight manuel,
      // qui prend UNE cible et ouvre une session SSH. Celle-ci balaye toutes les
      // cibles et enfile un `target:preflight` par cible : elle réutilise le
      // handler existant au lieu d'en dupliquer la logique.
      jobName: 'target:preflight:all',
      defaultKey: 'target:preflight',
      label: t('job.preflight.label'),
      description: t('job.preflight.description'),
      defaultCron: '0 * * * *',
      neverDoes: t('job.preflight.neverDoes'),
    },
  };
}

const TABLES = new Map<UiLanguage, Record<ScheduledJobType, ScheduledJobDefinition>>();

/**
 * La table dans une langue. Mémoïsée : une table par langue effectivement
 * demandée, construite une fois, jamais à chaque rendu.
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
 * La table en français. Conservée pour les appelants qui n'ont pas de langue à
 * offrir — le worker, la base — et qui n'y lisent de toute façon que `jobName`
 * et `defaultKey`.
 */
export const SCHEDULED_JOB_TYPES: Record<ScheduledJobType, ScheduledJobDefinition> =
  scheduledJobTypes('fr');

export const SCHEDULED_JOB_NAMES: readonly string[] = SCHEDULED_JOB_TYPES_LIST.map(
  (type) => SCHEDULED_JOB_TYPES[type].jobName,
);

/** Données portées par toute tâche issue du scheduler. */
export const scheduledJobDataSchema = z.object({
  scheduledJobId: z.string().uuid(),
  type: scheduledJobTypeSchema,
  key: z.string().min(1).max(120),
  payload: z.record(z.string(), z.unknown()).default({}),
  /** Renseigné pour un déclenchement manuel depuis l'UI. */
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

// ─── expressions cron ─────────────────────────────────────────────────────────

/**
 * Validation d'une expression cron à 5 ou 6 champs.
 *
 * Écrite ici plutôt que déléguée à `cron-parser` : ce paquet n'est chez nous
 * qu'une dépendance transitive de BullMQ, et s'appuyer dessus reviendrait à
 * dépendre d'un détail d'implémentation d'une autre bibliothèque. Le panel doit
 * pouvoir refuser une expression invalide **avant** de l'écrire en base.
 */
type CronBound = {
  /** Clé de logique et de libellé. Jamais affichée nue. */
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
 * `null` si l'expression est valide, sinon le motif du refus.
 *
 * Le motif s'affiche sous le champ de saisie : il se rend donc dans la langue
 * qu'on lui donne. Le défaut reste le français, pour `cronSchema` — un message
 * Zod voyage dans `details`, que le panel n'affiche pas.
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


// ─── périodicité simplifiée ───────────────────────────────────────────────────

/**
 * Périodicité exprimée sans écrire de cron.
 *
 * C'est une **surcouche de saisie**, pas un second format de stockage. Rien de
 * cette union n'est écrit en base : ce qui est persisté et ce que BullMQ
 * consomme reste l'expression cron produite par `toCron()`. Deux vérités
 * persistées finiraient par diverger ; celle-ci ne survit pas à la requête HTTP.
 *
 * `toCron()` et `fromCron()` sont réciproques :
 *   `toCron(fromCron(e)) === e`  pour toute expression que `fromCron` accepte
 *   `fromCron(toCron(s))` équivaut à `s`  pour toute `SimpleSchedule` valide
 * `scripts/test-schedule.ts` vérifie les deux sens.
 */

/** Les seuls intervalles proposés : au-delà, un cron dit la chose plus clairement. */
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
    // 0 = dimanche, comme cron. Plusieurs jours possibles, au moins un.
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    hour: hourField,
    minute: minuteField,
  }),
  z.object({
    kind: z.literal('monthly'),
    // 29 à 31 sont acceptés parce que cron les accepte : les mois trop courts
    // sont alors sautés. L'UI le dit ; on ne réécrit pas le choix de l'opérateur.
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

/** Périodicité simplifiée → expression cron à 5 champs. Toujours valide. */
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

/** Entier nu — ni plage, ni pas, ni liste. */
function plainInt(token: string, min: number, max: number): number | null {
  if (!/^\d{1,2}$/.test(token)) return null;
  const value = Number(token);
  return value >= min && value <= max ? value : null;
}

/** Jour de semaine nu : chiffre 0-7 (7 = dimanche) ou alias à trois lettres. */
function plainWeekday(token: string): number | null {
  const alias = DAY_ALIASES.indexOf(token.toLowerCase());
  if (alias >= 0) return alias;
  const value = plainInt(token, 0, 7);
  return value === null ? null : value % 7;
}

/**
 * Expression cron → périodicité simplifiée, ou `null`.
 *
 * **Tout ou rien.** On n'approche pas, on ne devine pas : une expression qui
 * n'a pas d'équivalent *exact* dans l'union rend `null`, et l'écran bascule en
 * mode expert plutôt que d'afficher une périodicité fausse.
 *
 * Accepté :
 *   `*&#47;N * * * *`  avec N ∈ {5, 10, 15, 30}            → interval
 *   `M * * * *`        M entier                            → hourly
 *   `M H * * *`        M et H entiers                      → daily
 *   `M H * * d[,d…]`   jours nus (0-7 ou `sun`…`sat`)      → weekly
 *   `M H D * *`        D entier 1-31                       → monthly
 *
 * Refusé — et c'est délibéré : toute plage (`2-5`), tout pas hors du champ
 * minute (`*&#47;3` en heure), tout mois restreint, toute combinaison jour du
 * mois **et** jour de semaine (cron les traite en OU, aucun `kind` ne le dit),
 * `*` en minute, et plus généralement toute forme non listée ci-dessus.
 *
 * Une expression à six champs n'est acceptée que si le champ seconde vaut
 * exactement `0` : `0 30 3 * * *` est alors *strictement* équivalent à
 * `30 3 * * *`. Ce n'est pas une approximation, c'est la même chose ; le retour
 * par `toCron()` produit la forme à cinq champs.
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

  // Un mois restreint n'a aucun équivalent simple : on s'arrête là.
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

// ─── fuseau horaire ───────────────────────────────────────────────────────────

/**
 * Fuseau d'une tâche planifiée.
 *
 * Le fuseau n'est **pas** celui du process qui ordonnance : il est porté par la
 * tâche (`scheduled_jobs.timezone`) et transmis à BullMQ sous la forme
 * `{ pattern, tz }`, depuis le panel comme depuis le worker. Sans cette option,
 * cron-parser retombait sur le fuseau du process — UTC dans nos conteneurs — et
 * une tâche réglée « à 3 h » tournait à 05:00 à Paris l'été.
 *
 * Le validateur est celui des paramètres d'instance : un seul juge de ce qu'est
 * un fuseau IANA — `Intl`, donc l'ICU réellement embarqué — et pas une seconde
 * liste qui divergerait de la première.
 */
export const scheduleTimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, { message: 'Fuseau horaire IANA inconnu' });

/**
 * Fuseau des tâches antérieures à la colonne `timezone`.
 *
 * `UTC`, et surtout pas le fuseau d'instance : ces tâches ont été installées
 * alors que BullMQ interprétait leur motif dans le fuseau du process, c'est-à-dire
 * en UTC. Leur appliquer rétroactivement `Europe/Paris` déplacerait de deux
 * heures l'exécution d'une tâche que personne n'a demandé à changer. La
 * migration `0009` pose donc cette valeur sur l'existant ; le fuseau d'instance
 * n'est le défaut que des tâches créées ensuite.
 */
export const LEGACY_SCHEDULE_TIMEZONE = 'UTC';

/**
 * Fuseau du navigateur qui regarde — jamais celui qui ordonnance.
 *
 * Sert uniquement à afficher, à côté de l'heure de la tâche, ce que cela donne
 * sur l'horloge du lecteur quand les deux fuseaux diffèrent.
 */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// ─── description lisible ──────────────────────────────────────────────────────

export type CronLocale = 'fr' | 'en';

export type DescribeCronOptions = {
  locale?: CronLocale | string;
  /** Affiché à côté de l'heure. C'est celui de la tâche. */
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
 * Description lisible d'une expression cron.
 *
 * Elle fonctionne pour **toute** expression valide, y compris celles que
 * `fromCron()` rejette : dans ce cas elle décrit champ par champ ce que
 * l'expression dit réellement, sans arrondir. Une expression invalide, ou une
 * forme qu'on ne sait pas mettre en mots, est rendue telle quelle — une
 * description fausse serait pire que pas de description.
 */
export function describeCron(expression: string, options: DescribeCronOptions = {}): string {
  const words = wordsFor(options.locale);
  const suffix = options.timeZone ? ` (${options.timeZone})` : '';

  const simple = fromCron(expression);
  if (simple) {
    switch (simple.kind) {
      case 'interval':
        // Un intervalle en minutes ne dépend d'aucun fuseau : pas de suffixe.
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

  // Une minute unique et des heures énumérées se disent en heures pleines —
  // « à 00:00, 03:00, 06:00 » plutôt que « aux minutes 0, à 0, 3, 6 h ».
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

  // Jour du mois et jour de semaine : cron les combine en OU dès que les deux
  // sont restreints. Le dire autrement serait faux.
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

/** Une énumération de vingt valeurs n'apprend rien : on la borne. */
function capList(values: readonly number[]): (number | string)[] {
  return values.length <= 8 ? [...values] : [...values.slice(0, 8), '…'];
}

// ─── prochaines occurrences ───────────────────────────────────────────────────

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
        // `5/10` signifie « à partir de 5, tous les 10 » ; `5` seul, juste 5.
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

/** Champs d'une expression cron, développés en ensembles de valeurs. */
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

  // 7 et 0 désignent tous deux le dimanche.
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

/** Champs horaires d'un instant, lus dans un fuseau donné. */
function wallClockOf(instantMs: number, timeZone: string): number {
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

/** Instant réel correspondant à une heure murale donnée dans un fuseau. */
function instantOfWallClock(wallMs: number, timeZone: string): number {
  let guess = wallMs - (wallClockOf(wallMs, timeZone) - wallMs);
  // Une seule reprise suffit : la correction ne dépasse jamais un décalage DST.
  guess = wallMs - (wallClockOf(guess, timeZone) - guess);
  return guess;
}

export type NextRunsOptions = {
  from?: Date;
  count?: number;
  /** Fuseau dans lequel l'expression est interprétée — celui de la tâche. */
  timeZone?: string;
  /** Au-delà, on renonce plutôt que de balayer indéfiniment. */
  horizonDays?: number;
};

/**
 * Prochaines occurrences d'une expression cron, dans un fuseau donné.
 *
 * Sert **uniquement** à l'aperçu du formulaire : pour une tâche déjà installée,
 * la prochaine occurrence affichée reste celle que BullMQ a calculée, sans quoi
 * deux calculs indépendants finiraient par ne plus dire la même chose. Ici il
 * n'y a rien dans Redis à interroger — l'expression n'est pas encore enregistrée.
 *
 * Rend un tableau vide si l'expression est invalide ou si aucune occurrence ne
 * tombe dans l'horizon (un `0 0 29 2 *` n'a rien à dire pendant trois ans).
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
  // On repart de la minute suivante : « maintenant » n'est pas une occurrence
  // à venir.
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
        // Un créneau avalé par un saut d'heure d'été n'existe pas : on le passe.
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

  // Sémantique cron historique : quand les deux champs sont restreints, un jour
  // convient s'il satisfait l'un **ou** l'autre.
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
