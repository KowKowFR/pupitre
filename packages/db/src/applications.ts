import { appSpecSchema, type AppSpec } from '@pupitre/core';
import { asc, count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Database } from './client.js';
import { deployments, portAllocations } from './schema/deployments.js';
import { applications, targets } from './schema/infra.js';
import {
  listApplicationDeletionBlockers,
  listDeploymentsHoldingName,
  type NameHolder,
} from './deployments.js';

export type Application = typeof applications.$inferSelect;

/**
 * Provenance of an AI-generated AppSpec.
 *
 * Optional: an application created by hand has none. When it is there, we keep
 * the user's request AND the spec as the model produced it, before review — it is
 * the only way to know, later, what was corrected by hand.
 */
export const generationOriginSchema = z.object({
  prompt: z.string().min(1).max(4000),
  model: z.string().min(1).max(200),
  appSpec: appSpecSchema,
});

export type GenerationOrigin = z.infer<typeof generationOriginSchema>;

export const createApplicationSchema = z.object({
  /** The slug comes from the AppSpec: a single source of truth for the name. */
  description: z.string().max(500).optional(),
  appSpec: appSpecSchema,
  generation: generationOriginSchema.optional(),
});

export const updateApplicationSchema = z.object({
  description: z.string().max(500).optional(),
  appSpec: appSpecSchema.optional(),
  /** Replacing the AppSpec with a new generation also replaces its provenance. */
  generation: generationOriginSchema.optional(),
});

export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;

export async function listApplications(db: Database = getDb()): Promise<Application[]> {
  return db.select().from(applications).orderBy(asc(applications.slug));
}

export async function getApplication(
  id: string,
  db: Database = getDb(),
): Promise<Application | null> {
  const [row] = await db.select().from(applications).where(eq(applications.id, id));
  return row ?? null;
}

export async function getApplicationBySlug(
  slug: string,
  db: Database = getDb(),
): Promise<Application | null> {
  const [row] = await db.select().from(applications).where(eq(applications.slug, slug));
  return row ?? null;
}

export async function createApplication(
  input: {
    appSpec: AppSpec;
    description?: string;
    ownerId?: string | null;
    generation?: GenerationOrigin;
  },
  db: Database = getDb(),
): Promise<Application> {
  const [row] = await db
    .insert(applications)
    .values({
      slug: input.appSpec.name,
      name: input.appSpec.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      appSpec: input.appSpec,
      ...(input.generation
        ? {
            generationPrompt: input.generation.prompt,
            generationModel: input.generation.model,
            generatedAppSpec: input.generation.appSpec,
            generatedAt: new Date(),
          }
        : {}),
      ownerId: input.ownerId ?? null,
    })
    .returning();

  if (!row) throw new Error('createApplication: the insert returned no row');
  return row;
}

/**
 * A name the machines would confuse. `deployed`: the application still holds
 * deployments under its current name, which is their project's name on the
 * machines — renaming it would leave them behind, under a name another
 * application could then take. `held`: another application's deployment still
 * holds the wanted name there.
 */
export class ApplicationNameError extends Error {
  constructor(
    readonly reason: 'deployed' | 'held',
    readonly wanted: string,
    readonly holders: NameHolder[],
  ) {
    super(
      reason === 'deployed'
        ? `the application is deployed: its name "${holders[0]?.applicationSlug}" is that of its project on the machines`
        : `"${wanted}" is still the name of a deployment of "${holders[0]?.applicationSlug}"`,
    );
    this.name = 'ApplicationNameError';
  }
}

/**
 * Refuses a name the machines would confuse with another — see
 * `ApplicationNameError`. `applicationId`: the application being renamed, whose
 * own deployments do not count against the name it already has.
 */
export async function assertApplicationNameFree(
  name: string,
  applicationId: string | null,
  db: Database = getDb(),
): Promise<void> {
  const holders = (await listDeploymentsHoldingName(name, db)).filter(
    (holder) => holder.applicationId !== applicationId,
  );
  if (holders.length > 0) throw new ApplicationNameError('held', name, holders);
}

/**
 * An application's name is its project on the machines: it only changes while
 * nothing is deployed under it. A rename with live deployments throws
 * `ApplicationNameError` — before, the deployments stayed on the machines under
 * the old name, and the next application to take it shared their project.
 */
export async function updateApplication(
  id: string,
  patch: { appSpec?: AppSpec; description?: string; generation?: GenerationOrigin },
  db: Database = getDb(),
): Promise<Application | null> {
  if (patch.appSpec) {
    const [current] = await db
      .select({ slug: applications.slug })
      .from(applications)
      .where(eq(applications.id, id));
    if (current && patch.appSpec.name !== current.slug) {
      const own = await listApplicationDeletionBlockers(id, { language: 'en' }, db);
      if (own.length > 0) {
        throw new ApplicationNameError(
          'deployed',
          patch.appSpec.name,
          own.map((blocker) => ({
            applicationId: id,
            applicationSlug: current.slug,
            targetName: blocker.targetName,
            version: blocker.version,
          })),
        );
      }
      await assertApplicationNameFree(patch.appSpec.name, id, db);
    }
  }
  const values: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.appSpec) {
    values.appSpec = patch.appSpec;
    values.slug = patch.appSpec.name;
    values.name = patch.appSpec.name;
  }
  if (patch.description !== undefined) values.description = patch.description;
  if (patch.generation) {
    values.generationPrompt = patch.generation.prompt;
    values.generationModel = patch.generation.model;
    values.generatedAppSpec = patch.generation.appSpec;
    values.generatedAt = new Date();
  }

  const [row] = await db
    .update(applications)
    .set(values)
    .where(eq(applications.id, id))
    .returning();
  return row ?? null;
}

export async function deleteApplication(id: string, db: Database = getDb()): Promise<boolean> {
  const [row] = await db
    .delete(applications)
    .where(eq(applications.id, id))
    .returning({ id: applications.id });
  return row !== undefined;
}

/**
 * What a forced erasure took away.
 *
 * Returned *to be logged*: once the transaction is through, these rows no longer
 * exist anywhere else.
 */
export type ApplicationErasure = {
  applicationId: string;
  applicationSlug: string;
  deploymentIds: string[];
  releasedPorts: Array<{ targetId: string; targetName: string; port: number }>;
};

/**
 * Erases the application, its whole history and all its port reservations,
 * **without any safeguard** — it is the caller that answers for its own.
 *
 * Two callers, two guards: `DELETE /api/applications/:id` only comes here after
 * observing that no deployment blocks (`listApplicationDeletionBlockers()`), and
 * the forced cascade only comes here after attempting the destruction and
 * **logging what it abandons**.
 *
 * Deliberately distinct from `purgeDeployments()`, which refuses what is alive:
 * loosening the purge's safeguard to serve the forced case would have made it
 * bypassable everywhere else. Here the contract is explicit from the name.
 *
 * Both foreign keys are `ON DELETE CASCADE`: deleting the application would be
 * enough. We still erase them explicitly, because a silent cascade returns
 * nothing — and one must be able to write in the log *which* ports were given
 * back and *which* deployments disappeared.
 */
export async function eraseApplication(
  id: string,
  db: Database = getDb(),
): Promise<ApplicationErasure | null> {
  return db.transaction(async (tx) => {
    const [application] = await tx
      .select({ id: applications.id, slug: applications.slug })
      .from(applications)
      .where(eq(applications.id, id));
    if (!application) return null;

    const allocations = await tx
      .select({
        targetId: portAllocations.targetId,
        targetName: targets.name,
        port: portAllocations.port,
      })
      .from(portAllocations)
      .innerJoin(targets, eq(targets.id, portAllocations.targetId))
      .where(eq(portAllocations.applicationId, id));

    await tx.delete(portAllocations).where(eq(portAllocations.applicationId, id));

    const erased = await tx
      .delete(deployments)
      .where(eq(deployments.applicationId, id))
      .returning({ id: deployments.id });

    await tx.delete(applications).where(eq(applications.id, id));

    return {
      applicationId: application.id,
      applicationSlug: application.slug,
      deploymentIds: erased.map((row) => row.id),
      releasedPorts: allocations,
    };
  });
}

/**
 * Deployments attached to an application, all statuses together.
 *
 * **Does not say whether the application can be deleted**: a `destroyed`
 * deployment counts here while it blocks nothing. For that question, and that
 * one alone, `listApplicationDeletionBlockers()` is authoritative.
 */
export async function countDeploymentsFor(
  applicationId: string,
  db: Database = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(deployments)
    .where(eq(deployments.applicationId, applicationId));
  return row?.value ?? 0;
}
