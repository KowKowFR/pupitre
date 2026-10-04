import type {
  SourceArchiveFormat,
  SourceArchiveRejection,
  SourceArchiveReport,
} from '@pupitre/core';
import { and, asc, count, desc, eq, inArray, notInArray } from 'drizzle-orm';
import { getDb, type Database } from './client.js';
import { users } from './schema/auth.js';
import { deployments } from './schema/deployments.js';
import { sourceArchiveChunks, sourceArchives } from './schema/sources.js';

/**
 * Uploaded code archives: their metadata, and their bytes stored in chunks.
 *
 * Nothing here reads or writes an archive in the format's sense: the route
 * stores what it receives, the worker judges and remakes the archive
 * (`@pupitre/core/source-upload`) then stores it in turn. This module only knows
 * chunks of bytes.
 */

export type SourceArchive = typeof sourceArchives.$inferSelect;
export type SourceArchiveChunkKind = 'upload' | 'tree';

/** An archive as the screen shows it: with the name of whoever uploaded it. */
export type SourceArchiveView = SourceArchive & { uploadedByName: string | null };

/** The deployments that have not finished: an archive they build is not erased. */
const IN_FLIGHT = ['pending', 'running'] as const;

/** An interrupted upload (panel stopped mid-transfer) is erased after this delay. */
const RECEIVING_STALE_MS = 60 * 60 * 1000;

export async function createSourceArchive(
  input: {
    applicationId: string;
    name: string;
    format: SourceArchiveFormat;
    uploadedBy: string | null;
  },
  db: Database = getDb(),
): Promise<SourceArchive> {
  const [row] = await db
    .insert(sourceArchives)
    .values({ ...input, status: 'receiving' })
    .returning();
  if (!row) throw new Error('createSourceArchive: the insert returned nothing');
  return row;
}

export async function appendSourceArchiveChunk(
  archiveId: string,
  kind: SourceArchiveChunkKind,
  seq: number,
  data: Buffer,
  db: Database = getDb(),
): Promise<void> {
  await db.insert(sourceArchiveChunks).values({ archiveId, kind, seq, data });
}

/** The upload is complete: the archive waits to be read by the worker. */
export async function finishSourceArchiveUpload(
  archiveId: string,
  result: { bytes: number; sha256: string },
  db: Database = getDb(),
): Promise<SourceArchive> {
  const [row] = await db
    .update(sourceArchives)
    .set({ status: 'pending', uploadedBytes: result.bytes, sha256: result.sha256 })
    .where(eq(sourceArchives.id, archiveId))
    .returning();
  if (!row) throw new Error(`archive ${archiveId} introuvable`);
  return row;
}

/** Removes an archive and its bytes (cascade). */
export async function deleteSourceArchive(
  archiveId: string,
  db: Database = getDb(),
): Promise<boolean> {
  const removed = await db
    .delete(sourceArchives)
    .where(eq(sourceArchives.id, archiveId))
    .returning({ id: sourceArchives.id });
  return removed.length > 0;
}

export async function getSourceArchive(
  archiveId: string,
  db: Database = getDb(),
): Promise<SourceArchive | null> {
  const [row] = await db.select().from(sourceArchives).where(eq(sourceArchives.id, archiveId));
  return row ?? null;
}

/** An application's archives, from newest to oldest. */
export async function listSourceArchives(
  applicationId: string,
  db: Database = getDb(),
): Promise<SourceArchiveView[]> {
  const rows = await db
    .select({ archive: sourceArchives, uploadedByName: users.name })
    .from(sourceArchives)
    .leftJoin(users, eq(users.id, sourceArchives.uploadedBy))
    .where(eq(sourceArchives.applicationId, applicationId))
    .orderBy(desc(sourceArchives.createdAt));
  return rows.map((row) => ({ ...row.archive, uploadedByName: row.uploadedByName }));
}

/**
 * The application's code: the most recent of the received archives — ready,
 * being read or refused. An upload still in progress does not count.
 */
export async function getCurrentSourceArchive(
  applicationId: string,
  db: Database = getDb(),
): Promise<SourceArchive | null> {
  const [row] = await db
    .select()
    .from(sourceArchives)
    .where(
      and(
        eq(sourceArchives.applicationId, applicationId),
        notInArray(sourceArchives.status, ['receiving']),
      ),
    )
    .orderBy(desc(sourceArchives.createdAt))
    .limit(1);
  return row ?? null;
}

export async function countSourceArchiveChunks(
  archiveId: string,
  kind: SourceArchiveChunkKind,
  db: Database = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(sourceArchiveChunks)
    .where(and(eq(sourceArchiveChunks.archiveId, archiveId), eq(sourceArchiveChunks.kind, kind)));
  return row?.value ?? 0;
}

/**
 * An archive's bytes, one chunk at a time: never the whole archive in memory,
 * neither in the panel nor in the worker.
 */
export async function* readSourceArchiveChunks(
  archiveId: string,
  kind: SourceArchiveChunkKind,
  db: Database = getDb(),
): AsyncGenerator<Buffer> {
  const total = await countSourceArchiveChunks(archiveId, kind, db);
  for (let seq = 0; seq < total; seq += 1) {
    const [row] = await db
      .select({ data: sourceArchiveChunks.data })
      .from(sourceArchiveChunks)
      .where(
        and(
          eq(sourceArchiveChunks.archiveId, archiveId),
          eq(sourceArchiveChunks.kind, kind),
          eq(sourceArchiveChunks.seq, seq),
        ),
      );
    if (!row) throw new Error(`archive ${archiveId}: chunk ${kind}#${seq} missing`);
    yield row.data;
  }
}

/** Erases the chunks of one kind — before rewriting the clean archive, for example. */
export async function clearSourceArchiveChunks(
  archiveId: string,
  kind: SourceArchiveChunkKind,
  db: Database = getDb(),
): Promise<void> {
  await db
    .delete(sourceArchiveChunks)
    .where(and(eq(sourceArchiveChunks.archiveId, archiveId), eq(sourceArchiveChunks.kind, kind)));
}

/**
 * Read and remade: the clean archive (`tree`) is stored, the received bytes are
 * no longer needed and are erased.
 */
export async function markSourceArchiveReady(
  archiveId: string,
  result: { archiveBytes: number; report: SourceArchiveReport },
  db: Database = getDb(),
): Promise<SourceArchive | null> {
  return db.transaction(async (tx) => {
    await tx
      .delete(sourceArchiveChunks)
      .where(
        and(eq(sourceArchiveChunks.archiveId, archiveId), eq(sourceArchiveChunks.kind, 'upload')),
      );
    const [row] = await tx
      .update(sourceArchives)
      .set({
        status: 'ready',
        archiveBytes: result.archiveBytes,
        report: result.report,
        rejection: null,
        rejectionDetail: null,
        inspectedAt: new Date(),
      })
      .where(eq(sourceArchives.id, archiveId))
      .returning();
    return row ?? null;
  });
}

/** Refused: we keep the reason, not the bytes. */
export async function markSourceArchiveRejected(
  archiveId: string,
  result: { rejection: SourceArchiveRejection; detail: string | null },
  db: Database = getDb(),
): Promise<SourceArchive | null> {
  return db.transaction(async (tx) => {
    await tx.delete(sourceArchiveChunks).where(eq(sourceArchiveChunks.archiveId, archiveId));
    const [row] = await tx
      .update(sourceArchives)
      .set({
        status: 'rejected',
        rejection: result.rejection,
        rejectionDetail: result.detail?.slice(0, 500) ?? null,
        archiveBytes: null,
        inspectedAt: new Date(),
      })
      .where(eq(sourceArchives.id, archiveId))
      .returning();
    return row ?? null;
  });
}

/** Is a deployment in progress building this archive? Then it is not erased. */
export async function sourceArchiveInFlight(
  archiveId: string,
  db: Database = getDb(),
): Promise<boolean> {
  const [row] = await db
    .select({ value: count() })
    .from(deployments)
    .where(
      and(eq(deployments.sourceArchiveId, archiveId), inArray(deployments.status, [...IN_FLIGHT])),
    );
  return (row?.value ?? 0) > 0;
}

/**
 * Only keeps an application's `keep` most recent archives, and erases the
 * uploads left in progress for more than an hour. An archive a deployment in
 * progress is building is spared. Returns what was erased.
 */
export async function pruneSourceArchives(
  applicationId: string,
  keep: number,
  db: Database = getDb(),
): Promise<{ id: string; name: string }[]> {
  const rows = await db
    .select({
      id: sourceArchives.id,
      name: sourceArchives.name,
      status: sourceArchives.status,
      createdAt: sourceArchives.createdAt,
    })
    .from(sourceArchives)
    .where(eq(sourceArchives.applicationId, applicationId))
    .orderBy(desc(sourceArchives.createdAt), asc(sourceArchives.id));

  const staleBefore = Date.now() - RECEIVING_STALE_MS;
  const received = rows.filter((row) => row.status !== 'receiving');
  const candidates = [
    ...received.slice(keep),
    ...rows.filter((row) => row.status === 'receiving' && row.createdAt.getTime() < staleBefore),
  ];
  const removed: { id: string; name: string }[] = [];
  for (const row of candidates) {
    if (await sourceArchiveInFlight(row.id, db)) continue;
    if (await deleteSourceArchive(row.id, db)) removed.push({ id: row.id, name: row.name });
  }
  return removed;
}
