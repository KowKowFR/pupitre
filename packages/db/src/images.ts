import type { ImageUpdateStatus } from '@pupitre/core';
import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { getDb, type Database } from './client.js';
import { imageUpdates, type ImageUpdateRow } from './schema/images.js';
import { applications, targets } from './schema/infra.js';

/**
 * The last finding about the deployed applications' images. Written by the
 * worker (`images:check`), read by the application record and the list.
 */

export type ImageCheckRecord = {
  applicationId: string;
  targetId: string;
  deploymentId: string | null;
  service: string;
  image: string;
  status: ImageUpdateStatus;
  runningDigest: string | null;
  latestDigest: string | null;
  newerTag: string | null;
  nextMajorTag: string | null;
  error: string | null;
};

/**
 * Replaces an (application, target) pair's finding, service by service, and
 * erases those of the services that no longer exist in the deployed AppSpec.
 *
 * Returns, for each service, the key already announced: it is the caller that
 * decides whether there is something new to say.
 */
export async function recordImageCheck(
  applicationId: string,
  targetId: string,
  records: ImageCheckRecord[],
  db: Database = getDb(),
): Promise<Map<string, string | null>> {
  const notified = new Map<string, string | null>();
  await db.transaction(async (tx) => {
    for (const record of records) {
      const [row] = await tx
        .insert(imageUpdates)
        .values({ ...record, checkedAt: new Date() })
        .onConflictDoUpdate({
          target: [imageUpdates.applicationId, imageUpdates.targetId, imageUpdates.service],
          set: {
            deploymentId: record.deploymentId,
            image: record.image,
            status: record.status,
            runningDigest: record.runningDigest,
            latestDigest: record.latestDigest,
            newerTag: record.newerTag,
            nextMajorTag: record.nextMajorTag,
            error: record.error,
            checkedAt: new Date(),
          },
        })
        .returning({ service: imageUpdates.service, notifiedKey: imageUpdates.notifiedKey });
      if (row) notified.set(row.service, row.notifiedKey);
    }

    const services = records.map((record) => record.service);
    await tx
      .delete(imageUpdates)
      .where(
        and(
          eq(imageUpdates.applicationId, applicationId),
          eq(imageUpdates.targetId, targetId),
          services.length > 0 ? notInArray(imageUpdates.service, services) : undefined,
        ),
      );
  });
  return notified;
}

/** Remembers what was just announced, so as not to announce it twice. */
export async function markImageNoticesSent(
  applicationId: string,
  targetId: string,
  keys: Map<string, string>,
  db: Database = getDb(),
): Promise<void> {
  for (const [service, key] of keys) {
    await db
      .update(imageUpdates)
      .set({ notifiedKey: key })
      .where(
        and(
          eq(imageUpdates.applicationId, applicationId),
          eq(imageUpdates.targetId, targetId),
          eq(imageUpdates.service, service),
        ),
      );
  }
}

/**
 * Forgets the findings of the pairs that no longer run: an application destroyed
 * on a target no longer has an image to update there.
 */
export async function pruneImageUpdates(
  live: Array<{ applicationId: string; targetId: string }>,
  db: Database = getDb(),
): Promise<number> {
  const keys = live.map((couple) => `${couple.applicationId}|${couple.targetId}`);
  const deleted = await db
    .delete(imageUpdates)
    .where(
      keys.length > 0
        ? sql`(${imageUpdates.applicationId}::text || '|' || ${imageUpdates.targetId}::text) NOT IN (${sql.join(
            keys.map((key) => sql`${key}`),
            sql`, `,
          )})`
        : undefined,
    )
    .returning({ id: imageUpdates.id });
  return deleted.length;
}

export type ImageUpdateView = ImageUpdateRow & { targetName: string };

/** An application's findings, target by target. */
export async function listImageUpdates(
  applicationId: string,
  db: Database = getDb(),
): Promise<ImageUpdateView[]> {
  const rows = await db
    .select({ row: imageUpdates, targetName: targets.name })
    .from(imageUpdates)
    .innerJoin(targets, eq(targets.id, imageUpdates.targetId))
    .where(eq(imageUpdates.applicationId, applicationId))
    .orderBy(asc(targets.name), asc(imageUpdates.service));
  return rows.map(({ row, targetName }) => ({ ...row, targetName }));
}

export type ImageUpdateSummary = {
  applicationId: string;
  slug: string;
  name: string;
  /** Services whose tag moved since the deployment. */
  outdated: number;
  /** Services for which a more recent tag of the same series exists. */
  newerTags: number;
};

/**
 * What there is to update, application by application — for the list and the
 * dashboard. An application with nothing to report is absent.
 */
export async function listImageUpdateSummaries(
  applicationIds?: string[],
  db: Database = getDb(),
): Promise<ImageUpdateSummary[]> {
  const rows = await db
    .select({
      applicationId: imageUpdates.applicationId,
      slug: applications.slug,
      name: applications.name,
      outdated: sql<number>`count(*) filter (where ${imageUpdates.status} = 'outdated')::int`,
      newerTags: sql<number>`count(*) filter (where ${imageUpdates.newerTag} is not null)::int`,
    })
    .from(imageUpdates)
    .innerJoin(applications, eq(applications.id, imageUpdates.applicationId))
    .where(
      applicationIds && applicationIds.length > 0
        ? inArray(imageUpdates.applicationId, applicationIds)
        : undefined,
    )
    .groupBy(imageUpdates.applicationId, applications.slug, applications.name);
  return rows.filter((row) => row.outdated > 0 || row.newerTags > 0);
}
