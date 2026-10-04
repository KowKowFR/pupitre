import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { AppSpec, ScanConfig } from '@pupitre/core';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { deploymentStatusEnum, healthStatusEnum, runtimeEnum, stepStatusEnum } from '../enums.js';
import { users } from './auth.js';
import { applications, targets } from './infra.js';
import { applicationSources, sourceArchives } from './sources.js';

export const deployments = pgTable(
  'deployments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Run number, global to the instance: `#129` designates a single run, whatever
     * the application. It is what is said out loud and typed in a search.
     *
     * Not to be confused with `version`, which counts the deployments **of one**
     * application and serves as the rollback marker. A Postgres sequence and not a
     * `max() + 1`: two deployments started at the same instant cannot get the same
     * number. A purged number is never reassigned.
     */
    number: integer('number').notNull().generatedByDefaultAsIdentity(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    runtime: runtimeEnum('runtime').notNull(),
    status: deploymentStatusEnum('status').notNull().default('pending'),
    /** Incremental version number per application. */
    version: integer('version').notNull().default(1),
    imageTag: text('image_tag'),
    url: text('url'),
    /**
     * AppSpec frozen at deployment time. `applications.app_spec` may change
     * afterwards: a deployment must stay readable as it was run, and a rollback must
     * start again from the right version.
     */
    appSpec: jsonb('app_spec').$type<AppSpec>(),
    /**
     * Chosen scanners and blocking threshold, frozen at deployment like the AppSpec.
     * The gate is data, never a hard-coded `if`.
     */
    scanConfig: jsonb('scan_config').$type<ScanConfig>(),
    publishedPort: integer('published_port'),
    /** Step the pipeline stopped on, if any. */
    failedStep: text('failed_step'),
    /**
     * Rollback policy, frozen at deployment like the AppSpec and the scan
     * configuration. A failed healthcheck then triggers the return to
     * `previous_deployment_id`, without intervention.
     *
     * It is data and not a global setting: the same application may deserve an
     * automatic rollback in production and a stop on failure in acceptance, where
     * one precisely wants to inspect the damage.
     */
    autoRollback: boolean('auto_rollback').notNull().default(true),
    /** Deployment a rollback brings back to. */
    previousDeploymentId: uuid('previous_deployment_id').references(
      (): AnyPgColumn => deployments.id,
      { onDelete: 'set null' },
    ),
    /**
     * Health observed by the **periodic** healthcheck, distinct from the
     * deployment's `status`: a `success` deployment can become `unreachable` three
     * hours later without ceasing to have succeeded. The periodic probe only writes
     * these two columns — it never rolls back.
     */
    healthStatus: healthStatusEnum('health_status').notNull().default('unknown'),
    lastHealthAt: timestamp('last_health_at', { withTimezone: true }),
    /**
     * Since when this application is **deliberately** stopped. `null`: it is
     * supposed to run.
     *
     * ── Why a column, and not a `stopped` value in the status ───────────────
     * Because `status` tells **a deployment's outcome** — did it succeed, fail, get
     * rolled back, destroyed — and a stop is not an outcome: the deployment
     * succeeded, and it still succeeded an hour after the containers were cut.
     * Overwriting `success` with `stopped` would lose that information, and the day
     * of the restart one would have to guess what to go back to.
     *
     * The practical consequence confirms the theory: `status` governs
     * `isSupervisable()`, hence access to logs and restart. One more value would
     * silence a stopped application's console — that is, at the precise moment one
     * wants to read the last lines to know why it was stopped.
     *
     * A timestamp rather than a boolean: "stopped since Tuesday" is what the screen
     * needs to say, and a boolean would never have known it.
     */
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
    triggeredBy: text('triggered_by').references(() => users.id, { onDelete: 'set null' }),
    /**
     * The link to a repository that triggered this run, and the exact commit: we
     * redeploy what ran, not "the latest version of main". The repository and the
     * branch are copied — a deleted link must not make the history silent about the
     * code's origin.
     */
    sourceId: uuid('source_id').references(() => applicationSources.id, { onDelete: 'set null' }),
    sourceRepository: text('source_repository'),
    sourceRef: text('source_ref'),
    sourceSha: text('source_sha'),
    /**
     * The repository's web address, as its forge serves it: the link to the commit
     * follows from it, whether GitHub, Gitea or GitLab, and outlives the link.
     */
    sourceUrl: text('source_url'),
    /**
     * The uploaded code archive this run builds — the code's other origin. Its name
     * and its hash are copied for the same reason as the repository: a discarded
     * archive does not make the history silent.
     */
    sourceArchiveId: uuid('source_archive_id').references(() => sourceArchives.id, {
      onDelete: 'set null',
    }),
    sourceArchiveName: text('source_archive_name'),
    sourceArchiveSha256: text('source_archive_sha256'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('deployments_application_id_idx').on(t.applicationId),
    index('deployments_target_id_idx').on(t.targetId),
    index('deployments_status_idx').on(t.status),
    uniqueIndex('deployments_application_version_idx').on(t.applicationId, t.version),
    uniqueIndex('deployments_number_idx').on(t.number),
  ],
);

/** State machine visible in the UI: one row per pipeline step. */
export const deploymentSteps = pgTable(
  'deployment_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => deployments.id, { onDelete: 'cascade' }),
    order: integer('order').notNull(),
    /** The step's stable identifier, e.g. `render`, `upload`, `compose_up`. */
    key: text('key').notNull(),
    label: text('label').notNull(),
    status: stepStatusEnum('status').notNull().default('pending'),
    error: text('error'),
    /**
     * The step's log, appended. Duplicates the Redis channel on purpose: Redis
     * broadcasts live, this column allows replay afterwards.
     */
    log: text('log').notNull().default(''),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('deployment_steps_deployment_order_idx').on(t.deploymentId, t.order),
    index('deployment_steps_deployment_id_idx').on(t.deploymentId),
  ],
);

/**
 * Port collision avoidance. The guarantee is the unique `(target_id, port)`
 * constraint — never an `if` in TypeScript.
 */
export const portAllocations = pgTable(
  'port_allocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    port: integer('port').notNull(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('port_allocations_target_port_idx').on(t.targetId, t.port),
    index('port_allocations_application_id_idx').on(t.applicationId),
  ],
);
