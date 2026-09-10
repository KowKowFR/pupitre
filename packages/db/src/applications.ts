import { appSpecSchema, type AppSpec } from '@tp/core';
import { asc, count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Database } from './client.js';
import { deployments } from './schema/deployments.js';
import { applications } from './schema/infra.js';

export type Application = typeof applications.$inferSelect;

/**
 * Provenance d'une AppSpec générée par IA.
 *
 * Facultative : une application créée à la main n'en a pas. Quand elle est là,
 * on garde la demande de l'utilisateur ET la spec telle que le modèle l'a
 * produite, avant relecture — c'est la seule façon de savoir, plus tard, ce qui
 * a été corrigé à la main.
 */
export const generationOriginSchema = z.object({
  prompt: z.string().min(1).max(4000),
  model: z.string().min(1).max(200),
  appSpec: appSpecSchema,
});

export type GenerationOrigin = z.infer<typeof generationOriginSchema>;

export const createApplicationSchema = z.object({
  /** Le slug vient de l'AppSpec : une seule source de vérité pour le nom. */
  description: z.string().max(500).optional(),
  appSpec: appSpecSchema,
  generation: generationOriginSchema.optional(),
});

export const updateApplicationSchema = z.object({
  description: z.string().max(500).optional(),
  appSpec: appSpecSchema.optional(),
  /** Remplacer l'AppSpec par une nouvelle génération remplace aussi sa provenance. */
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

  if (!row) throw new Error("createApplication : l'insertion n'a retourné aucune ligne");
  return row;
}

export async function updateApplication(
  id: string,
  patch: { appSpec?: AppSpec; description?: string; generation?: GenerationOrigin },
  db: Database = getDb(),
): Promise<Application | null> {
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

/** Déploiements rattachés à une application, tous statuts confondus. */
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
