import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { scheduledJobTypeEnum, stepStatusEnum } from '../enums.js';
import { apiTokens } from './api-tokens.js';
import { users } from './auth.js';

/**
 * Journal d'audit. Alimenté **exclusivement** par `logAudit()`.
 * Aucun insert dispersé dans les handlers.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** `null` pour les actions système (worker, scheduler). */
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: text('ip'),
    /**
     * Le navigateur ou le client qui a émis la requête, tel qu'il s'annonce.
     * `null` pour une action du worker, qui n'a pas de requête derrière elle.
     */
    userAgent: text('user_agent'),
    /**
     * Le jeton d'API par lequel l'acteur a agi, ou `null` pour une session de
     * navigateur (et pour le worker). Renseigné par le contexte de la requête,
     * comme le navigateur : aucun appel à `logAudit()` n'a à y penser.
     */
    apiTokenId: uuid('api_token_id').references(() => apiTokens.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_actor_id_idx').on(t.actorId),
    index('audit_logs_created_at_idx').on(t.createdAt),
    index('audit_logs_resource_idx').on(t.resourceType, t.resourceId),
  ],
);

/**
 * Miroir en base des repeatable jobs BullMQ.
 * Pas de cron Linux : BullMQ est la seule source d'ordonnancement.
 */
export const scheduledJobs = pgTable(
  'scheduled_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Clé BullMQ du repeatable job. */
    key: text('key').notNull().unique(),
    type: scheduledJobTypeEnum('type').notNull(),
    cron: text('cron').notNull(),
    /**
     * Fuseau IANA dans lequel le motif cron est interprété, passé à BullMQ en
     * `{ pattern, tz }`. Le défaut de colonne vaut `UTC` — pas le fuseau
     * d'instance : il n'existe que pour l'existant, cf. migration `0009`.
     */
    timezone: text('timezone').notNull().default('UTC'),
    payload: jsonb('payload').notNull().default({}),
    enabled: boolean('enabled').notNull().default(true),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('scheduled_jobs_enabled_idx').on(t.enabled)],
);

/**
 * Historique des exécutions planifiées.
 *
 * Table dédiée et non `audit_logs` : ce ne sont pas les mêmes questions. Le
 * journal d'audit répond à « qui a fait quoi », il est append-only et lu par un
 * humain qui enquête. Cette table-ci répond à « le scan de 4 h du matin
 * a-t-il tourné, combien de temps, et qu'a-t-il trouvé » — elle est cadrée par
 * une clé étrangère, purgée avec sa tâche, et affichée en regard du cron.
 * Les deux existent : chaque exécution passe aussi par `logAudit()`.
 */
export const scheduledJobRuns = pgTable(
  'scheduled_job_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scheduledJobId: uuid('scheduled_job_id')
      .notNull()
      .references(() => scheduledJobs.id, { onDelete: 'cascade' }),
    /** Réutilise l'échelle des étapes de déploiement : mêmes états, même vocabulaire. */
    status: stepStatusEnum('status').notNull().default('running'),
    /** Déclenché à la main depuis l'UI, ou par le scheduler BullMQ. */
    manual: boolean('manual').notNull().default(false),
    /** Ce que la tâche a fait, sous une forme propre à son type. */
    summary: jsonb('summary'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('scheduled_job_runs_job_id_idx').on(t.scheduledJobId),
    index('scheduled_job_runs_started_at_idx').on(t.startedAt),
  ],
);
