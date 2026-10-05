import {
  DEFAULT_UI_LANGUAGE,
  DEPLOYMENT_STEPS,
  deploymentStepLabel,
  scanConfigSchema,
  workspaceNameFor,
  type UiLanguage,
  type AppSpec,
  type DeploymentStatus,
  type DeploymentStepKey,
  type ScanConfig,
  type StepStatus,
  invalid,
} from '@pupitre/core';
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  lt,
  max,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Database } from './client.js';
import { deploymentSteps, deployments, portAllocations } from './schema/deployments.js';
import { applications, targets } from './schema/infra.js';
import { scanRuns } from './schema/security.js';
import { users } from './schema/auth.js';
import { dbSay, type DbSay } from './messages.js';

/**
 * Deployment state machine.
 *
 * The steps are created **when the job is queued**, all `pending`: the UI shows
 * the complete pipeline before the worker has started anything.
 */

export type Deployment = typeof deployments.$inferSelect;
export type DeploymentStep = typeof deploymentSteps.$inferSelect;

export type DeploymentSummary = {
  id: string;
  /** Run number, global to the instance (`#129`). */
  number: number;
  status: DeploymentStatus;
  runtime: 'docker' | 'k3s';
  version: number;
  url: string | null;
  publishedPort: number | null;
  failedStep: string | null;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  applicationId: string;
  applicationSlug: string;
  targetId: string;
  targetName: string;
  targetHost: string;
  triggeredByEmail: string | null;
  previousDeploymentId: string | null;
  scanConfig: ScanConfig | null;
  autoRollback: boolean;
  /** Not null: the application was deliberately stopped at this date. */
  stoppedAt: Date | null;
  /** The repository, the branch and the exact commit, when the run comes from a linked repo. */
  sourceRepository: string | null;
  sourceRef: string | null;
  sourceSha: string | null;
  sourceUrl: string | null;
  /** The uploaded archive and its hash, when the code came from there. */
  sourceArchiveName: string | null;
  sourceArchiveSha256: string | null;
};

const summaryColumns = {
  id: deployments.id,
  number: deployments.number,
  status: deployments.status,
  runtime: deployments.runtime,
  version: deployments.version,
  url: deployments.url,
  publishedPort: deployments.publishedPort,
  failedStep: deployments.failedStep,
  error: deployments.error,
  startedAt: deployments.startedAt,
  finishedAt: deployments.finishedAt,
  createdAt: deployments.createdAt,
  applicationId: deployments.applicationId,
  applicationSlug: applications.slug,
  targetId: deployments.targetId,
  targetName: targets.name,
  targetHost: targets.host,
  triggeredByEmail: users.email,
  previousDeploymentId: deployments.previousDeploymentId,
  scanConfig: deployments.scanConfig,
  autoRollback: deployments.autoRollback,
  stoppedAt: deployments.stoppedAt,
  sourceRepository: deployments.sourceRepository,
  sourceRef: deployments.sourceRef,
  sourceSha: deployments.sourceSha,
  sourceUrl: deployments.sourceUrl,
  sourceArchiveName: deployments.sourceArchiveName,
  sourceArchiveSha256: deployments.sourceArchiveSha256,
} as const;

function summaryQuery(db: Database) {
  return db
    .select(summaryColumns)
    .from(deployments)
    .innerJoin(applications, eq(applications.id, deployments.applicationId))
    .innerJoin(targets, eq(targets.id, deployments.targetId))
    .leftJoin(users, eq(users.id, deployments.triggeredBy));
}

// ─── creation ─────────────────────────────────────────────────────────────────

export const createDeploymentSchema = z.object({
  applicationId: z.string().uuid(),
  targetId: z.string().uuid(),
  runtime: z.enum(['docker', 'k3s']),
  /**
   * Scanners and blocking threshold.
   *
   * **Absent and empty are not the same thing**, hence `optional()` rather than a
   * default: absent means "apply the instance's policy", `{scanners: []}` means "I
   * want no scan, knowingly". Confusing the two would make a client that does not
   * mention it disarm the analysis without knowing it.
   */
  scanConfig: scanConfigSchema.optional(),
  /**
   * Automatic return to the previous version if the healthcheck fails.
   *
   * Ticked by default, here as in the form: losing a version that worked because
   * one forgot to tick a box is the wrong default.
   */
  autoRollback: z.boolean().default(true),
});

export type CreateDeploymentInput = z.infer<typeof createDeploymentSchema>;

/**
 * Creates the deployment **and all its steps as `pending`**, in a single
 * transaction. The version number is incremental per application.
 */
export async function createDeploymentWithSteps(
  input: CreateDeploymentInput & {
    appSpec: AppSpec;
    triggeredBy: string | null;
    /** The code's origin, when the run comes from a linked repository. */
    source?: {
      sourceId: string | null;
      repository: string;
      ref: string | null;
      sha: string;
      /** The repository's web address at its forge — from which the commit's link is derived. */
      url: string | null;
    };
    /** The code's origin, when it is an uploaded archive. */
    archive?: { id: string | null; name: string; sha256: string };
  },
  db: Database = getDb(),
): Promise<{ deployment: Deployment; steps: DeploymentStep[] }> {
  return db.transaction(async (tx) => {
    const [latest] = await tx
      .select({ value: max(deployments.version) })
      .from(deployments)
      .where(eq(deployments.applicationId, input.applicationId));

    const version = (latest?.value ?? 0) + 1;

    // Last successful deployment: the target of a possible rollback.
    const [previous] = await tx
      .select({ id: deployments.id })
      .from(deployments)
      .where(
        and(
          eq(deployments.applicationId, input.applicationId),
          eq(deployments.targetId, input.targetId),
          eq(deployments.status, 'success'),
        ),
      )
      .orderBy(desc(deployments.version))
      .limit(1);

    const [deployment] = await tx
      .insert(deployments)
      .values({
        applicationId: input.applicationId,
        targetId: input.targetId,
        runtime: input.runtime,
        status: 'pending',
        version,
        appSpec: input.appSpec,
        scanConfig: input.scanConfig,
        autoRollback: input.autoRollback,
        triggeredBy: input.triggeredBy,
        previousDeploymentId: previous?.id ?? null,
        ...(input.source
          ? {
              sourceId: input.source.sourceId,
              sourceRepository: input.source.repository,
              sourceRef: input.source.ref,
              sourceSha: input.source.sha,
              sourceUrl: input.source.url,
            }
          : {}),
        ...(input.archive
          ? {
              sourceArchiveId: input.archive.id,
              sourceArchiveName: input.archive.name,
              sourceArchiveSha256: input.archive.sha256,
            }
          : {}),
      })
      .returning();

    if (!deployment) throw new Error("createDeployment: the insert returned nothing");

    const steps = await tx
      .insert(deploymentSteps)
      .values(
        DEPLOYMENT_STEPS.map((step, index) => ({
          deploymentId: deployment.id,
          order: index,
          key: step.key,
          label: step.label,
          status: 'pending' as const,
        })),
      )
      .returning();

    return { deployment, steps };
  });
}

// ─── reading ──────────────────────────────────────────────────────────────────

export const deploymentQuerySchema = z.object({
  applicationId: z.string().uuid().optional(),
  targetId: z.string().uuid().optional(),
  status: z.enum(['pending', 'running', 'success', 'failed', 'rolled_back', 'destroyed']).optional(),
  runtime: z.enum(['docker', 'k3s']).optional(),
  /**
   * Free search: a piece of the application's slug or name, of the target's name,
   * or a run number (`129`, `#129`).
   */
  q: z.string().trim().max(100).optional(),
  /**
   * Runs stopped by a blocking verdict. `scan` is the only value for now: it is an
   * enumeration so that another safeguard can be added without a new parameter.
   */
  blocked: z.enum(['scan']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type DeploymentQuery = z.infer<typeof deploymentQuerySchema>;

/** The filters alone, without pagination: what the export takes from the list. */
export type DeploymentFilter = Omit<DeploymentQuery, 'page' | 'pageSize'>;

/** `%` and `_` are `ILIKE` wildcards: an input searches for them literally. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * The conditions of a list of deployments.
 *
 * They are about `applications` and `targets`: any query that uses them must do
 * the same joins as `summaryQuery()`.
 */
function deploymentWhere(filter: DeploymentFilter) {
  const term = filter.q?.trim() ?? '';
  const run = /^#?(\d{1,9})$/.exec(term);
  const search =
    term === ''
      ? undefined
      : or(
          ilike(applications.slug, likePattern(term)),
          ilike(applications.name, likePattern(term)),
          ilike(targets.name, likePattern(term)),
          run ? eq(deployments.number, Number(run[1])) : undefined,
        );

  // Blocked by a scan: the pipeline stopped at the analysis step AND a scanner
  // returned a blocking verdict. The step alone is not enough — a scanner that
  // crashes gives no verdict, and blocks nothing.
  const blockedByScan =
    filter.blocked === 'scan'
      ? and(
          eq(deployments.failedStep, 'scan'),
          sql`exists (select 1 from ${scanRuns} where ${scanRuns.deploymentId} = ${deployments.id} and ${scanRuns.verdict} = 'fail')`,
        )
      : undefined;

  const conditions = [
    filter.applicationId ? eq(deployments.applicationId, filter.applicationId) : undefined,
    filter.targetId ? eq(deployments.targetId, filter.targetId) : undefined,
    filter.status ? eq(deployments.status, filter.status) : undefined,
    filter.runtime ? eq(deployments.runtime, filter.runtime) : undefined,
    search,
    blockedByScan,
  ].filter((condition) => condition !== undefined);

  return conditions.length > 0 ? and(...conditions) : undefined;
}

export type DeploymentPage = {
  items: DeploymentSummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export async function listDeployments(
  query: DeploymentQuery,
  db: Database = getDb(),
): Promise<DeploymentPage> {
  const where = deploymentWhere(query);

  const [items, total] = await Promise.all([
    summaryQuery(db)
      .where(where)
      .orderBy(desc(deployments.createdAt), desc(deployments.number))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    countDeployments(query, db),
  ]);

  return {
    items,
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

/** Number of runs matching the filters. */
export async function countDeployments(
  filter: DeploymentFilter,
  db: Database = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(deployments)
    .innerJoin(applications, eq(applications.id, deployments.applicationId))
    .innerJoin(targets, eq(targets.id, deployments.targetId))
    .where(deploymentWhere(filter));
  return row?.value ?? 0;
}

/**
 * All the runs matching the filters, in batches, from newest to oldest: it is
 * the export's read.
 *
 * Cursor pagination (`number` descending) and not offset: a run created during
 * the export does not shift the pages, so it makes neither a duplicate nor a
 * gap. `limit` caps the total, batches included.
 */
export async function* iterateDeployments(
  filter: DeploymentFilter,
  options: { limit: number; batchSize?: number },
  db: Database = getDb(),
): AsyncGenerator<DeploymentSummary[]> {
  const batchSize = options.batchSize ?? 500;
  let remaining = options.limit;
  let before: number | null = null;

  while (remaining > 0) {
    const where = deploymentWhere(filter);
    const batch: DeploymentSummary[] = await summaryQuery(db)
      .where(before === null ? where : and(where, lt(deployments.number, before)))
      .orderBy(desc(deployments.number))
      .limit(Math.min(batchSize, remaining));

    if (batch.length === 0) return;
    yield batch;
    remaining -= batch.length;
    before = batch[batch.length - 1]!.number;
    if (batch.length < batchSize) return;
  }
}

export async function getDeploymentSummary(
  id: string,
  db: Database = getDb(),
): Promise<DeploymentSummary | null> {
  const [row] = await summaryQuery(db).where(eq(deployments.id, id));
  return row ?? null;
}

export async function listSteps(
  deploymentId: string,
  db: Database = getDb(),
): Promise<DeploymentStep[]> {
  return db
    .select()
    .from(deploymentSteps)
    .where(eq(deploymentSteps.deploymentId, deploymentId))
    .orderBy(asc(deploymentSteps.order));
}

/** Everything the worker needs, in one query. */
export async function getDeploymentForRun(
  id: string,
  db: Database = getDb(),
): Promise<{ deployment: Deployment; steps: DeploymentStep[] } | null> {
  const [deployment] = await db.select().from(deployments).where(eq(deployments.id, id));
  if (!deployment) return null;
  return { deployment, steps: await listSteps(id, db) };
}

// ─── transitions ──────────────────────────────────────────────────────────────

export async function markDeploymentRunning(
  id: string,
  db: Database = getDb(),
): Promise<void> {
  await db
    .update(deployments)
    .set({ status: 'running', startedAt: new Date(), error: null, failedStep: null, updatedAt: new Date() })
    .where(eq(deployments.id, id));
}

export async function finishDeployment(
  id: string,
  status: DeploymentStatus,
  detail: {
    url?: string | null;
    publishedPort?: number | null;
    imageTag?: string | null;
    failedStep?: string | null;
    error?: string | null;
  } = {},
  db: Database = getDb(),
): Promise<void> {
  await db
    .update(deployments)
    .set({
      status,
      finishedAt: new Date(),
      updatedAt: new Date(),
      ...(detail.url !== undefined ? { url: detail.url } : {}),
      ...(detail.publishedPort !== undefined ? { publishedPort: detail.publishedPort } : {}),
      ...(detail.imageTag !== undefined ? { imageTag: detail.imageTag } : {}),
      ...(detail.failedStep !== undefined ? { failedStep: detail.failedStep } : {}),
      ...(detail.error !== undefined ? { error: detail.error } : {}),
    })
    .where(eq(deployments.id, id));
}

export async function startStep(
  deploymentId: string,
  key: DeploymentStepKey,
  db: Database = getDb(),
): Promise<void> {
  await db
    .update(deploymentSteps)
    .set({ status: 'running', startedAt: new Date(), finishedAt: null, error: null })
    .where(and(eq(deploymentSteps.deploymentId, deploymentId), eq(deploymentSteps.key, key)));
}

export async function finishStep(
  deploymentId: string,
  key: DeploymentStepKey,
  status: Exclude<StepStatus, 'pending' | 'running'>,
  error: string | null = null,
  db: Database = getDb(),
): Promise<void> {
  await db
    .update(deploymentSteps)
    .set({ status, finishedAt: new Date(), error })
    .where(and(eq(deploymentSteps.deploymentId, deploymentId), eq(deploymentSteps.key, key)));
}

/** After a failure: everything that did not run goes to `skipped`. */
export async function skipPendingSteps(
  deploymentId: string,
  db: Database = getDb(),
): Promise<DeploymentStepKey[]> {
  const rows = await db
    .update(deploymentSteps)
    .set({ status: 'skipped', finishedAt: new Date() })
    .where(
      and(
        eq(deploymentSteps.deploymentId, deploymentId),
        inArray(deploymentSteps.status, ['pending', 'running']),
      ),
    )
    .returning({ key: deploymentSteps.key });

  return rows.map((row) => row.key as DeploymentStepKey);
}

/**
 * Puts back to `pending` everything that did not succeed, for a retry. Steps
 * already `success` stay as they are: that is what makes the job idempotent.
 */
export async function resetUnsuccessfulSteps(
  deploymentId: string,
  db: Database = getDb(),
): Promise<void> {
  await db
    .update(deploymentSteps)
    .set({ status: 'pending', startedAt: null, finishedAt: null, error: null })
    .where(
      and(
        eq(deploymentSteps.deploymentId, deploymentId),
        ne(deploymentSteps.status, 'success'),
      ),
    );
}

// ─── log ──────────────────────────────────────────────────────────────────────

/**
 * Appends a block of lines to a step's log. The append is done by the database
 * (`log || $chunk`): two concurrent writes cannot overwrite each other.
 */
export async function appendStepLog(
  deploymentId: string,
  key: DeploymentStepKey,
  chunk: string,
  db: Database = getDb(),
): Promise<void> {
  if (chunk.length === 0) return;
  await db
    .update(deploymentSteps)
    .set({ log: sql`${deploymentSteps.log} || ${chunk}` })
    .where(and(eq(deploymentSteps.deploymentId, deploymentId), eq(deploymentSteps.key, key)));
}

/** Complete log, in step order. Used for SSE replay. */
export async function readDeploymentLog(
  deploymentId: string,
  db: Database = getDb(),
): Promise<Array<{ key: string; log: string }>> {
  const rows = await db
    .select({ key: deploymentSteps.key, log: deploymentSteps.log })
    .from(deploymentSteps)
    .where(eq(deploymentSteps.deploymentId, deploymentId))
    .orderBy(asc(deploymentSteps.order));

  return rows.filter((row) => row.log.length > 0);
}

// ─── version history ──────────────────────────────────────────────────────────

/** A deployed version, as the application's timeline shows it. */
export type ApplicationVersion = {
  deploymentId: string;
  version: number;
  /** Application version from the AppSpec frozen at this deployment. */
  appVersion: string | null;
  imageTag: string | null;
  runtime: 'docker' | 'k3s';
  status: DeploymentStatus;
  url: string | null;
  publishedPort: number | null;
  targetId: string;
  targetName: string;
  triggeredByEmail: string | null;
  sourceRepository: string | null;
  sourceRef: string | null;
  sourceSha: string | null;
  sourceUrl: string | null;
  /** The uploaded archive the version built, when the code came from there. */
  sourceArchiveName: string | null;
  sourceArchiveSha256: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  /** A version without an AppSpec cannot be redeployed: there is nothing to replay. */
  redeployable: boolean;
};

/**
 * An application's complete history, from newest to oldest.
 *
 * We read `deployments`, never a separate history table: the deployment *is*
 * the version. Its frozen `app_spec` is what makes a redeploy possible months
 * later, even if the application has changed since.
 */
export async function listApplicationVersions(
  applicationId: string,
  db: Database = getDb(),
): Promise<ApplicationVersion[]> {
  const rows = await db
    .select({
      deploymentId: deployments.id,
      version: deployments.version,
      appSpec: deployments.appSpec,
      imageTag: deployments.imageTag,
      runtime: deployments.runtime,
      status: deployments.status,
      url: deployments.url,
      publishedPort: deployments.publishedPort,
      targetId: deployments.targetId,
      targetName: targets.name,
      triggeredByEmail: users.email,
      sourceRepository: deployments.sourceRepository,
      sourceRef: deployments.sourceRef,
      sourceSha: deployments.sourceSha,
      sourceUrl: deployments.sourceUrl,
      sourceArchiveName: deployments.sourceArchiveName,
      sourceArchiveSha256: deployments.sourceArchiveSha256,
      createdAt: deployments.createdAt,
      finishedAt: deployments.finishedAt,
    })
    .from(deployments)
    .innerJoin(targets, eq(targets.id, deployments.targetId))
    .leftJoin(users, eq(users.id, deployments.triggeredBy))
    .where(eq(deployments.applicationId, applicationId))
    .orderBy(desc(deployments.version));

  return rows.map((row) => {
    const { appSpec, ...rest } = row;
    return {
      ...rest,
      appVersion: appSpec?.version ?? null,
      redeployable: appSpec !== null,
    };
  });
}

// ─── "what runs" — single definition ─────────────────────────────────────────

/**
 * ## The only definition of "alive"
 *
 * For an (application, target) pair, we read its history **from newest to
 * oldest** and stop at the first verdict:
 *
 * - `pending` / `running`: no verdict yet, we keep going down. A deployment in
 *   progress does not make what runs meanwhile disappear.
 * - `failed`: we **keep** the most recent as "last failed update", but keep going
 *   down. A failure does not necessarily replace what was running — see
 *   `startedServices()`.
 * - `success` / `rolled_back`: it is **the** deployment in service. A
 *   `rolled_back` counts as much as a `success`: after a rollback, it is indeed
 *   the old version that serves.
 *
 * If the descent found no deployment in service but the last failure happened
 * **from the `deploy` step on**, the pair is still considered occupied:
 * containers may have started and stayed there.
 *
 * A destruction (`destroyed`) cuts this descent, but **by time and not by
 * version number**: `destroy` takes down the whole `app-{slug}` project, not
 * only the version it was started on. Every deployment finished before the last
 * destruction has therefore disappeared from the machine, including a higher
 * version number. Destroying v1 takes v2 with it.
 *
 * ### Why it leans that way
 *
 * The database does not say what the machine carries, it says what the panel
 * believes. Between the two possible errors, the cost is not the same:
 *
 * - being wrong by keeping one pair too many → one extra line on the monitoring
 *   screen, and a deployment that must be destroyed before purging it;
 * - being wrong by forgetting it → an application still running on the machine
 *   that the panel can no longer name: no more logs, no more rollback, no more
 *   clean destruction, and a port reserved for a ghost.
 *
 * The second cannot be recovered from the panel. **When in doubt, we therefore
 * consider that something still runs.** It is for the same reason that an
 * unknown or absent `failed_step` is treated as "the services may have
 * started".
 *
 * The target's real inventory (`listWorkloads` on the `DeploymentDriver`) would
 * tell the truth. It is deliberately not called here: this function serves the
 * purge path, which is a database operation and must not depend on a remote
 * machine's reachability — a target turned off would make the history
 * unpurgeable.
 */

/** The index of `deploy`: the first step that really starts services. */
const DEPLOY_STEP_INDEX = DEPLOYMENT_STEPS.findIndex((step) => step.key === 'deploy');

/**
 * Could this failed deployment have left containers behind?
 *
 * Everything before `deploy` — preflight, reservation, render, upload, build,
 * scan — can fail without anything running: the previous version never stopped
 * serving. From `deploy` on, the target was touched.
 */
function startedServices(failedStep: string | null): boolean {
  // No named step: we do not know where it stopped, so we assume the worst.
  if (failedStep === null) return true;
  const index = DEPLOYMENT_STEPS.findIndex((step) => step.key === failedStep);
  if (index === -1) return true;
  return index >= DEPLOY_STEP_INDEX;
}

/** What an (application, target) pair still carries, per the definition above. */
export type LiveDeployment = {
  applicationId: string;
  targetId: string;
  /**
   * The deployment serving the application. `null` when only a failure occupies
   * the target: nothing ever succeeded on this pair.
   */
  inService: Deployment | null;
  /** The pair's last deployment if it failed, and none succeeded it. */
  lastFailed: Deployment | null;
  /**
   * The deployments whose database trace must not be erased: they are the only
   * handles left to find, stop or destroy what runs. `lastFailed` is only part of
   * it if it is the only handle.
   */
  pinnedIds: string[];
};

/** Applies the definition to a single pair's history, from newest to oldest. */
function resolveLive(rows: Deployment[]): LiveDeployment | null {
  // Date of the pair's last destruction: everything that finished before it was
  // taken down with the project, whatever its version number.
  let destroyedAt: Date | null = null;
  for (const row of rows) {
    if (row.status !== 'destroyed' || row.finishedAt === null) continue;
    if (destroyedAt === null || row.finishedAt > destroyedAt) destroyedAt = row.finishedAt;
  }

  // `finishedAt` absent: we cannot date it, so we assume it survived.
  const survives = (row: Deployment): boolean =>
    destroyedAt === null || row.finishedAt === null || row.finishedAt > destroyedAt;

  let lastFailed: Deployment | null = null;
  let inService: Deployment | null = null;

  for (const row of rows) {
    // `pending` / `running`: no verdict yet. `destroyed`: already taken into account
    // by `destroyedAt`.
    if (row.status === 'pending' || row.status === 'running' || row.status === 'destroyed') continue;
    if (!survives(row)) continue;

    if (row.status === 'failed') {
      lastFailed ??= row;
      continue;
    }

    inService = row;
    break;
  }

  if (inService !== null) {
    return {
      applicationId: inService.applicationId,
      targetId: inService.targetId,
      inService,
      lastFailed,
      pinnedIds: [inService.id],
    };
  }

  if (lastFailed !== null && startedServices(lastFailed.failedStep)) {
    return {
      applicationId: lastFailed.applicationId,
      targetId: lastFailed.targetId,
      inService: null,
      lastFailed,
      pinnedIds: [lastFailed.id],
    };
  }

  return null;
}

/**
 * Every (application, target) pair on which something may still run. **It is
 * the single definition**: monitoring, purge and worker all derive from it, none
 * rewrites the rule.
 */
export async function listLiveDeployments(
  filter: { applicationId?: string; targetId?: string } = {},
  db: Database = getDb(),
): Promise<LiveDeployment[]> {
  const conditions = [
    filter.applicationId ? eq(deployments.applicationId, filter.applicationId) : undefined,
    filter.targetId ? eq(deployments.targetId, filter.targetId) : undefined,
  ].filter((condition) => condition !== undefined);

  const rows = await db
    .select()
    .from(deployments)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(deployments.version), desc(deployments.createdAt));

  const couples = new Map<string, Deployment[]>();
  for (const row of rows) {
    const key = `${row.applicationId}|${row.targetId}`;
    const bucket = couples.get(key);
    if (bucket) bucket.push(row);
    else couples.set(key, [row]);
  }

  const live: LiveDeployment[] = [];
  for (const bucket of couples.values()) {
    const resolved = resolveLive(bucket);
    if (resolved) live.push(resolved);
  }
  return live;
}

/**
 * Is anything of this application still alive on this target?
 *
 * Used by the worker to decide whether it can release the port reservation
 * after a failure. The deployment that just failed **is not excluded** from the
 * question: if it went past `deploy`, it is its own containers that occupy the
 * port, and giving it back would give it to another application.
 */
export async function hasLiveDeploymentOnTarget(
  applicationId: string,
  targetId: string,
  db: Database = getDb(),
): Promise<boolean> {
  const live = await listLiveDeployments({ applicationId, targetId }, db);
  return live.length > 0;
}

/**
 * Each pair's deployment **in service** — the one the periodic tasks probe and
 * scan.
 *
 * Derived from `listLiveDeployments()`: a pair only occupied by a failure has
 * nothing to probe, it does not appear here.
 */
export async function listCurrentDeployments(
  db: Database = getDb(),
): Promise<Deployment[]> {
  const live = await listLiveDeployments({}, db);
  return live
    .map((row) => row.inService)
    .filter((row): row is Deployment => row !== null);
}

/**
 * Marks an application as deliberately stopped, or unmarks it.
 *
 * The deployment's `status` is **not** touched: it tells the outcome of going
 * live, not what the containers are doing right now. See the comment of the
 * `stopped_at` column in `schema/deployments.ts`.
 *
 * Health drops to `unknown` along with the stop: leaving `healthy` on an
 * application where nothing runs anymore would be a lie shown on the dashboard,
 * and the periodic probe will not come by to correct it — it precisely skips
 * stopped applications.
 */
export async function setDeploymentStopped(
  id: string,
  stoppedAt: Date | null,
  db: Database = getDb(),
): Promise<void> {
  await db
    .update(deployments)
    .set({
      stoppedAt,
      updatedAt: new Date(),
      ...(stoppedAt ? { healthStatus: 'unknown' as const, lastHealthAt: stoppedAt } : {}),
    })
    .where(eq(deployments.id, id));
}

/** Health status observed by the periodic probe. Triggers no action. */
export async function recordHealthStatus(
  id: string,
  status: 'unknown' | 'healthy' | 'unhealthy' | 'unreachable',
  at: Date = new Date(),
  db: Database = getDb(),
): Promise<void> {
  await db
    .update(deployments)
    .set({ healthStatus: status, lastHealthAt: at })
    .where(eq(deployments.id, id));
}


/**
 * The pair's last update, when it failed.
 *
 * Present, it says the deployment in service **is no longer the last attempt**:
 * someone tried to replace it and failed. The screen must say so frankly rather
 * than make the line disappear.
 */
export type LastFailedUpdate = {
  deploymentId: string;
  /** Run number of the failed attempt. */
  number: number;
  version: number;
  failedStep: string | null;
  error: string | null;
  finishedAt: Date | null;
  /** The failure happened from `deploy` on: the containers may have been replaced. */
  mayHaveReplacedServices: boolean;
};

/** A running application, as the monitoring screen presents it. */
export type SupervisedApp = DeploymentSummary & {
  healthStatus: 'unknown' | 'healthy' | 'unhealthy' | 'unreachable';
  lastHealthAt: Date | null;
  appName: string;
  services: string[];
  lastFailedUpdate: LastFailedUpdate | null;
};

/**
 * What runs *now*, one line per (application, target) pair.
 *
 * Distinct from `listDeployments`, which tells the history. The selection rule
 * is `listLiveDeployments()`'s — it is not rewritten here. The line carries the
 * identifier of the deployment **in service** (`success` or `rolled_back`), the
 * only state where application logs and restart make sense; a more recent
 * failure appears in `lastFailedUpdate` instead of making the application
 * disappear.
 */
export async function listSupervisedApps(db: Database = getDb()): Promise<SupervisedApp[]> {
  const live = await listLiveDeployments({}, db);

  const inService = new Map<string, LiveDeployment>();
  for (const row of live) {
    if (row.inService) inService.set(row.inService.id, row);
  }
  if (inService.size === 0) return [];

  const rows = await db
    .select({
      ...summaryColumns,
      healthStatus: deployments.healthStatus,
      lastHealthAt: deployments.lastHealthAt,
      appName: applications.name,
      appSpec: deployments.appSpec,
    })
    .from(deployments)
    .innerJoin(applications, eq(applications.id, deployments.applicationId))
    .innerJoin(targets, eq(targets.id, deployments.targetId))
    .leftJoin(users, eq(users.id, deployments.triggeredBy))
    .where(inArray(deployments.id, [...inService.keys()]));

  return rows
    .map(({ appSpec, ...row }) => {
      const failed = inService.get(row.id)?.lastFailed ?? null;
      return {
        ...row,
        services: appSpec?.services.map((service) => service.name) ?? [],
        lastFailedUpdate: failed
          ? {
              deploymentId: failed.id,
              number: failed.number,
              version: failed.version,
              failedStep: failed.failedStep,
              error: failed.error,
              finishedAt: failed.finishedAt,
              mayHaveReplacedServices: startedServices(failed.failedStep),
            }
          : null,
      };
    })
    .sort((a, b) => a.applicationSlug.localeCompare(b.applicationSlug));
}

// ─── history purge ────────────────────────────────────────────────────────────

/**
 * Purging is not destroying.
 *
 * `destroy` goes to the target machine and takes the application down. Purging
 * erases a deployment's **database trace**, without touching the target. Hence
 * the single safeguard: we do not purge a deployment that monitors something
 * alive, otherwise the application would keep running on the machine without
 * the panel still knowing how to name it — no more logs, no more rollback, no
 * more destruction possible, and its port would stay reserved for a ghost.
 */

/** Why a deployment resisted the purge. */
export type PurgeRefusalReason = 'live' | 'in_progress';

export type PurgeRefusal = {
  id: string;
  number: number;
  status: DeploymentStatus;
  version: number;
  applicationSlug: string;
  targetName: string;
  reason: PurgeRefusalReason;
  message: string;
};

/**
 * Cap of rows handled per call.
 *
 * A deliberate choice of the **synchronous route** rather than a BullMQ job: the
 * purge is a `DELETE ... WHERE id = ANY(...)` in a transaction, with cascades on
 * indexed foreign keys. At 500 rows it is a matter of tens of milliseconds, very
 * far from a "long-running operation" in the sense of rule 2 — which targets
 * remote work (SSH, build, scan), not a bounded local write. Going through the
 * queue would cost a round trip and, above all, would make *asynchronous* the
 * only information that matters here: what was refused and why. We therefore
 * cap, and say so in the response (`truncated`) rather than let the request
 * grow without limit.
 */
export const PURGE_MAX_ROWS = 500;

export const purgeFilterSchema = z
  .object({
    /** Explicit selection — it is what the user ticks in the table. */
    ids: z.array(z.string().uuid()).min(1).max(PURGE_MAX_ROWS).optional(),
    statuses: z
      .array(z.enum(['pending', 'running', 'success', 'failed', 'rolled_back', 'destroyed']))
      .min(1)
      .optional(),
    /** "Older than N days", computed on `created_at`. */
    olderThanDays: z.number().int().min(0).max(3650).optional(),
    applicationId: z.string().uuid().optional(),
    targetId: z.string().uuid().optional(),
  })
  .refine(
    (filter) =>
      filter.ids !== undefined ||
      filter.statuses !== undefined ||
      filter.olderThanDays !== undefined ||
      filter.applicationId !== undefined ||
      filter.targetId !== undefined,
    // An empty filter would target the whole history. It is not a purge, it is an
    // accident: we require at least one criterion.
    invalid('purge.criteria'),
  );

export type PurgeFilter = z.infer<typeof purgeFilterSchema>;

export type PurgeReport = {
  /** Deployments matching the filter, cap not applied. */
  matched: number;
  /** What was (or would be) erased. */
  purged: string[];
  purgedCount: number;
  /** Count per status of what was (or would be) erased. */
  purgedByStatus: Record<string, number>;
  refused: PurgeRefusal[];
  refusedCount: number;
  /** Reservations returned to their target's port range. */
  releasedPorts: Array<{ targetId: string; targetName: string; port: number }>;
  /**
   * Live deployments that lose their rollback target: `previous_deployment_id` is
   * `ON DELETE SET NULL`, purging a historical version cuts it.
   */
  rollbackTargetsLost: number;
  /** The cap cut the selection: rows remain to be purged. */
  truncated: boolean;
  limit: number;
  dryRun: boolean;
};

/** Why a deployment is the panel's last handle on something alive. */
type PinnedKind = 'in_service' | 'only_handle';

/**
 * Deployments we refuse to purge, and the reason.
 *
 * Delegates to `listLiveDeployments()` — the single definition of "alive".
 * Rewriting it here would doom the two to diverge one day; it is exactly what
 * had happened, and what made purgeable the version in service of an
 * application whose last update had failed.
 */
export async function listPinnedDeployments(
  db: Database = getDb(),
  filter: { applicationId?: string; targetId?: string } = {},
): Promise<Map<string, PinnedKind>> {
  const live = await listLiveDeployments(filter, db);
  const pinned = new Map<string, PinnedKind>();
  for (const row of live) {
    for (const id of row.pinnedIds) {
      pinned.set(id, row.inService ? 'in_service' : 'only_handle');
    }
  }
  return pinned;
}

/** The same, without the reason — the deployments screen greys out the box with it. */
export async function listLiveDeploymentIds(db: Database = getDb()): Promise<Set<string>> {
  return new Set((await listPinnedDeployments(db)).keys());
}

/**
 * What **really blocks** deleting an application.
 *
 * The question "can this application be deleted?" is not "does it carry
 * deployments?" but "is there one left the panel must not lose sight of?". A
 * `destroyed` deployment is a history record: it blocks nothing.
 *
 * The verdict and its vocabulary are the purge's — `refuse()`, and behind it
 * `listLiveDeployments()`. A third set of rules here would have guaranteed that
 * the two diverge one day, and it is exactly the error
 * `listPinnedDeployments()` already corrected.
 *
 * The fields beyond `PurgeRefusal` do not serve the refusal but what comes
 * after: they name, target by target, what a forced action would abandon.
 */
export type ApplicationDeletionBlocker = PurgeRefusal & {
  applicationId: string;
  targetId: string;
  targetHost: string;
  runtime: 'docker' | 'k3s';
  publishedPort: number | null;
};

export async function listApplicationDeletionBlockers(
  applicationId: string,
  /** `language`: that of the messages, which the screen shows as is. */
  options: { language?: UiLanguage } = {},
  db: Database = getDb(),
): Promise<ApplicationDeletionBlocker[]> {
  const say = dbSay(options.language ?? DEFAULT_UI_LANGUAGE);
  const [rows, pinned] = await Promise.all([
    db
      .select({
        id: deployments.id,
        number: deployments.number,
        status: deployments.status,
        version: deployments.version,
        applicationId: deployments.applicationId,
        applicationSlug: applications.slug,
        targetId: deployments.targetId,
        targetName: targets.name,
        targetHost: targets.host,
        runtime: deployments.runtime,
        publishedPort: deployments.publishedPort,
      })
      .from(deployments)
      .innerJoin(applications, eq(applications.id, deployments.applicationId))
      .innerJoin(targets, eq(targets.id, deployments.targetId))
      .where(eq(deployments.applicationId, applicationId))
      .orderBy(asc(deployments.version)),
    listPinnedDeployments(db, { applicationId }),
  ]);

  const blockers: ApplicationDeletionBlocker[] = [];
  for (const row of rows) {
    const refusal = refuse(row, pinned, say);
    if (!refusal) continue;
    blockers.push({
      ...refusal,
      applicationId: row.applicationId,
      targetId: row.targetId,
      targetHost: row.targetHost,
      runtime: row.runtime,
      publishedPort: row.publishedPort,
    });
  }
  return blockers;
}

type PurgeCandidate = {
  id: string;
  number: number;
  status: DeploymentStatus;
  version: number;
  applicationId: string;
  applicationSlug: string;
  targetId: string;
  targetName: string;
};

function purgeWhere(filter: PurgeFilter) {
  const now = Date.now();
  const conditions = [
    filter.ids ? inArray(deployments.id, filter.ids) : undefined,
    filter.statuses ? inArray(deployments.status, filter.statuses) : undefined,
    filter.olderThanDays !== undefined
      ? lt(deployments.createdAt, new Date(now - filter.olderThanDays * 86_400_000))
      : undefined,
    filter.applicationId ? eq(deployments.applicationId, filter.applicationId) : undefined,
    filter.targetId ? eq(deployments.targetId, filter.targetId) : undefined,
  ].filter((condition) => condition !== undefined);

  return conditions.length > 0 ? and(...conditions) : undefined;
}

/**
 * Previews then runs the purge.
 *
 * `dryRun` takes exactly the same decision path: the count announced to the user
 * is the one that will be applied, not an estimate computed elsewhere.
 */
export async function purgeDeployments(
  filter: PurgeFilter,
  /** `language`: that of the refusals, which the screen shows as is. */
  options: { dryRun?: boolean; language?: UiLanguage } = {},
  db: Database = getDb(),
): Promise<PurgeReport> {
  const dryRun = options.dryRun ?? false;
  const say = dbSay(options.language ?? DEFAULT_UI_LANGUAGE);
  const where = purgeWhere(filter);

  const [candidates, [totalRow], pinned] = await Promise.all([
    db
      .select({
        id: deployments.id,
        number: deployments.number,
        status: deployments.status,
        version: deployments.version,
        applicationId: deployments.applicationId,
        applicationSlug: applications.slug,
        targetId: deployments.targetId,
        targetName: targets.name,
      })
      .from(deployments)
      .innerJoin(applications, eq(applications.id, deployments.applicationId))
      .innerJoin(targets, eq(targets.id, deployments.targetId))
      .where(where)
      // Oldest first: if the cap cuts, it cuts the recent tail, and two successive
      // calls finish the work.
      .orderBy(asc(deployments.createdAt))
      .limit(PURGE_MAX_ROWS),
    db.select({ value: count() }).from(deployments).where(where),
    listPinnedDeployments(db),
  ]);

  const matched = totalRow?.value ?? 0;

  const purgeable: PurgeCandidate[] = [];
  const refused: PurgeRefusal[] = [];

  for (const candidate of candidates) {
    const refusal = refuse(candidate, pinned, say);
    if (refusal) refused.push(refusal);
    else purgeable.push(candidate);
  }

  const purgedByStatus: Record<string, number> = {};
  for (const row of purgeable) {
    purgedByStatus[row.status] = (purgedByStatus[row.status] ?? 0) + 1;
  }

  const ids = purgeable.map((row) => row.id);

  const base: PurgeReport = {
    matched,
    purged: ids,
    purgedCount: ids.length,
    purgedByStatus,
    refused,
    refusedCount: refused.length,
    releasedPorts: [],
    rollbackTargetsLost: 0,
    truncated: matched > candidates.length,
    limit: PURGE_MAX_ROWS,
    dryRun,
  };

  if (ids.length === 0) return base;

  const rollbackTargetsLost = await countRollbackTargetsLost(ids, db);

  if (dryRun) return { ...base, rollbackTargetsLost };

  const releasedPorts = await db.transaction(async (tx) => {
    await tx.delete(deployments).where(inArray(deployments.id, ids));

    // `deployment_steps`, `scan_runs` and their `findings` go by cascade (foreign
    // key `ON DELETE CASCADE`). `audit_logs` does not: its `resource_id` column is a
    // `text` without a foreign key — the log outlives what it describes, and that
    // is intended.
    return releaseOrphanAllocations(purgeable, tx);
  });

  return { ...base, releasedPorts, rollbackTargetsLost };
}

/** The only verdict that counts: does this deployment monitor something? */
function refuse(
  candidate: PurgeCandidate,
  pinned: ReadonlyMap<string, PinnedKind>,
  say: DbSay,
): PurgeRefusal | null {
  const identity = say('purge.identity', {
    slug: candidate.applicationSlug,
    version: candidate.version,
    target: candidate.targetName,
  });

  if (candidate.status === 'pending' || candidate.status === 'running') {
    return {
      ...refusalIdentity(candidate),
      reason: 'in_progress',
      message: say('purge.inProgress', { identity }),
    };
  }

  const kind = pinned.get(candidate.id);
  if (kind === 'in_service') {
    return {
      ...refusalIdentity(candidate),
      reason: 'live',
      message: say('purge.inService', { identity }),
    };
  }

  if (kind === 'only_handle') {
    return {
      ...refusalIdentity(candidate),
      reason: 'live',
      message: say('purge.onlyHandle', { identity }),
    };
  }

  return null;
}

function refusalIdentity(candidate: PurgeCandidate): Omit<PurgeRefusal, 'reason' | 'message'> {
  return {
    id: candidate.id,
    number: candidate.number,
    status: candidate.status,
    version: candidate.version,
    applicationSlug: candidate.applicationSlug,
    targetName: candidate.targetName,
  };
}

/** Surviving deployments whose rollback target is about to disappear. */
async function countRollbackTargetsLost(ids: string[], db: Database): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(deployments)
    .where(
      and(
        inArray(deployments.previousDeploymentId, ids),
        // A deployment itself purged "loses" nothing.
        notInArray(deployments.id, ids),
      ),
    );
  return row?.value ?? 0;
}

/**
 * Returns to the port range the reservations the purge just orphaned.
 *
 * `port_allocations` is indexed by (target, application) and not by deployment:
 * the reservation is therefore only released if **no** deployment of that pair
 * remains. As long as one remains, something may still occupy that port on the
 * machine, and giving it back would amount to promising it to another
 * application.
 */
async function releaseOrphanAllocations(
  purged: PurgeCandidate[],
  tx: Database,
): Promise<Array<{ targetId: string; targetName: string; port: number }>> {
  const couples = new Map<string, { applicationId: string; targetId: string; targetName: string }>();
  for (const row of purged) {
    couples.set(`${row.applicationId}|${row.targetId}`, {
      applicationId: row.applicationId,
      targetId: row.targetId,
      targetName: row.targetName,
    });
  }

  const released: Array<{ targetId: string; targetName: string; port: number }> = [];

  for (const couple of couples.values()) {
    const [remaining] = await tx
      .select({ id: deployments.id })
      .from(deployments)
      .where(
        and(
          eq(deployments.applicationId, couple.applicationId),
          eq(deployments.targetId, couple.targetId),
        ),
      )
      .limit(1);

    if (remaining) continue;

    const rows = await tx
      .delete(portAllocations)
      .where(
        and(
          eq(portAllocations.targetId, couple.targetId),
          eq(portAllocations.applicationId, couple.applicationId),
        ),
      )
      .returning({ port: portAllocations.port });

    for (const row of rows) {
      released.push({ targetId: couple.targetId, targetName: couple.targetName, port: row.port });
    }
  }

  return released;
}

// ─── stuck deployments ────────────────────────────────────────────────────────

/**
 * A deployment the database still believes in progress.
 *
 * Everything needed to give the verdict (identifiers to query the queue) **and**
 * to write the after-the-fact message: what may have stayed on the machine is
 * not found elsewhere once the deployment is concluded.
 */
export type UnfinishedDeployment = {
  id: string;
  status: 'pending' | 'running';
  version: number;
  runtime: 'docker' | 'k3s';
  applicationId: string;
  applicationSlug: string;
  targetId: string;
  targetName: string;
  targetHost: string;
  publishedPort: number | null;
  /** Reservation still recorded in `port_allocations`, even without a published port. */
  allocatedPort: number | null;
  createdAt: Date;
  startedAt: Date | null;
  /** The step in progress when it stopped — the only thing that says where it froze. */
  currentStep: { key: string; label: string } | null;
};

/**
 * Everything the database believes in progress, without exception or sorting by
 * age.
 *
 * Filtering by age is not done here: it is a decision rule
 * (`STUCK_DEPLOYMENT_GRACE_MS`), it belongs to the caller that gives the
 * verdict, not to the read.
 */
export async function listUnfinishedDeployments(
  db: Database = getDb(),
): Promise<UnfinishedDeployment[]> {
  const rows = await db
    .select({
      id: deployments.id,
      status: deployments.status,
      version: deployments.version,
      runtime: deployments.runtime,
      applicationId: deployments.applicationId,
      applicationSlug: applications.slug,
      targetId: deployments.targetId,
      targetName: targets.name,
      targetHost: targets.host,
      publishedPort: deployments.publishedPort,
      allocatedPort: portAllocations.port,
      createdAt: deployments.createdAt,
      startedAt: deployments.startedAt,
    })
    .from(deployments)
    .innerJoin(applications, eq(applications.id, deployments.applicationId))
    .innerJoin(targets, eq(targets.id, deployments.targetId))
    .leftJoin(
      portAllocations,
      and(
        eq(portAllocations.targetId, deployments.targetId),
        eq(portAllocations.applicationId, deployments.applicationId),
      ),
    )
    .where(inArray(deployments.status, ['pending', 'running']))
    .orderBy(asc(deployments.createdAt));

  if (rows.length === 0) return [];

  const running = await db
    .select({
      deploymentId: deploymentSteps.deploymentId,
      key: deploymentSteps.key,
      label: deploymentSteps.label,
    })
    .from(deploymentSteps)
    .where(
      and(
        inArray(
          deploymentSteps.deploymentId,
          rows.map((row) => row.id),
        ),
        eq(deploymentSteps.status, 'running'),
      ),
    );

  const steps = new Map(running.map((step) => [step.deploymentId, step]));

  return rows.map((row) => {
    const step = steps.get(row.id);
    return {
      ...row,
      status: row.status as 'pending' | 'running',
      currentStep: step ? { key: step.key, label: step.label } : null,
    };
  });
}

/** What the unblocking did — enough to write the activity log entry. */
export type AbandonReport = {
  id: string;
  applicationSlug: string;
  targetName: string;
  /** The step the deployment stopped on. `null` if it had started nothing. */
  failedStep: string | null;
  /** The services may have started: the target may still carry something. */
  mayHaveStartedServices: boolean;
  /** The message written on the deployment, word for word. */
  error: string;
};

/**
 * Composes the message recorded on an abandoned deployment.
 *
 * It is written **here**, at the single place where abandonment is written, and
 * not in the route or the worker: both unblocking paths — the manual gesture
 * and the automatic recovery when BullMQ fails a job without having run it —
 * must leave exactly the same trace, otherwise the log tells two stories for one
 * incident.
 *
 * It does not say "interrupted". It says **what happened**, **why it is final**
 * and above all **what remains to check on the machine**: the panel does not
 * know and cannot know without going there, so it is the only information worth
 * keeping.
 */
function abandonMessage(
  row: UnfinishedDeployment,
  cause: string,
  observedAt: Date,
  language: UiLanguage,
): string {
  const say = dbSay(language);
  const workspace = workspaceNameFor(row.applicationSlug);
  const port = row.publishedPort ?? row.allocatedPort;
  const where = `${row.targetName} (${row.targetHost})`;
  const stamp = observedAt.toISOString();

  const opening = row.currentStep
    ? say('abandon.stoppedAt', {
        step: deploymentStepLabel(row.currentStep.key, language, row.currentStep.label),
      })
    : row.status === 'pending'
      ? say('abandon.neverStarted')
      : say('abandon.stoppedNoStep');

  // Three situations, three different things to go and check. The distinction
  // between the last two is the rest of the product's — the `deploy` step is the
  // first that really touches the machine.
  let remains: string;
  if (row.status === 'pending') {
    remains = say('abandon.pending', { workspace, where });
  } else if (startedServices(row.currentStep?.key ?? null)) {
    // No runtime word here (rule no. 1): "services" covers the containers of a
    // Compose project as well as the pods of a namespace.
    remains = say('abandon.started', {
      where,
      workspace,
      port: port !== null ? say('abandon.started.port', { port }) : '',
    });
  } else {
    remains = say('abandon.beforeServices', {
      workspace,
      where,
      port: port !== null ? say('abandon.beforeServices.port', { port }) : '',
    });
  }

  return say('abandon.message', { opening, cause, stamp, remains });
}

/**
 * Stops a stuck deployment on a failure verdict.
 *
 * **Mark as failed, never resume.** Replaying a pipeline without knowing where
 * it stopped would redeploy on top of something: the running version may have
 * been half replaced, the containers may be up, the port may be taken. Telling
 * the truth about an uncertain state and letting the human lift the uncertainty
 * — by a destruction, or by going to look — is the only honest course.
 *
 * The `WHERE status IN ('pending','running')` is not decorative: between the
 * verdict and the write, a worker may very well have concluded the deployment.
 * The database decides, not us — a `null` return means "it finished by itself
 * in the meantime", and the caller must say so rather than overwrite.
 *
 * The step in progress goes to `failed` and not `skipped`: it is the one that
 * says where it stopped, and the deployment's screen shows it.
 */
export async function abandonDeployment(
  id: string,
  /** `language`: that of the verdict written in the deployment's error. */
  options: { cause: string; observedAt?: Date; language?: UiLanguage },
  db: Database = getDb(),
): Promise<AbandonReport | null> {
  const observedAt = options.observedAt ?? new Date();

  // We go through the shared read rather than write an ad hoc query: the message
  // must be composed from the same fields, whatever the origin of the unblocking.
  // There are never many deployments in progress.
  const row = (await listUnfinishedDeployments(db)).find((candidate) => candidate.id === id);
  if (!row) return null;

  const error = abandonMessage(
    row,
    options.cause,
    observedAt,
    options.language ?? DEFAULT_UI_LANGUAGE,
  );
  const failedStep = row.currentStep?.key ?? null;

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(deployments)
      .set({
        status: 'failed',
        failedStep,
        error,
        finishedAt: observedAt,
        updatedAt: observedAt,
      })
      .where(and(eq(deployments.id, id), inArray(deployments.status, ['pending', 'running'])))
      .returning({ id: deployments.id });

    if (updated.length === 0) return null;

    if (failedStep !== null) {
      await tx
        .update(deploymentSteps)
        .set({ status: 'failed', finishedAt: observedAt, error })
        .where(
          and(eq(deploymentSteps.deploymentId, id), eq(deploymentSteps.key, failedStep)),
        );
    }

    await tx
      .update(deploymentSteps)
      .set({ status: 'skipped', finishedAt: observedAt })
      .where(
        and(
          eq(deploymentSteps.deploymentId, id),
          inArray(deploymentSteps.status, ['pending', 'running']),
        ),
      );

    return {
      id,
      applicationSlug: row.applicationSlug,
      targetName: row.targetName,
      failedStep,
      mayHaveStartedServices: startedServices(failedStep),
      error,
    };
  });
}
