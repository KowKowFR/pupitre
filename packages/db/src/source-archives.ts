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
 * Archives de code téléversées : leurs métadonnées, et leurs octets rangés par
 * morceaux.
 *
 * Rien ici ne lit ni n'écrit une archive au sens du format : la route range
 * ce qu'elle reçoit, le worker juge et refait l'archive (`@pupitre/core/source-upload`)
 * puis la range à son tour. Ce module ne connaît que des morceaux d'octets.
 */

export type SourceArchive = typeof sourceArchives.$inferSelect;
export type SourceArchiveChunkKind = 'upload' | 'tree';

/** Une archive telle que l'écran la montre : avec le nom de qui l'a envoyée. */
export type SourceArchiveView = SourceArchive & { uploadedByName: string | null };

/** Les déploiements qui n'ont pas fini : une archive qu'ils construisent ne s'efface pas. */
const IN_FLIGHT = ['pending', 'running'] as const;

/** Un envoi interrompu (panel arrêté en plein transfert) s'efface au bout de ce délai. */
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
  if (!row) throw new Error("createSourceArchive : l'insertion n'a rien retourné");
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

/** L'envoi est complet : l'archive attend sa lecture par le worker. */
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

/** Retire une archive et ses octets (cascade). */
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

/** Les archives d'une application, de la plus récente à la plus ancienne. */
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
 * Le code de l'application : la plus récente des archives reçues — prête, en
 * lecture ou refusée. Un envoi encore en cours ne compte pas.
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
 * Les octets d'une archive, un morceau à la fois : jamais l'archive entière en
 * mémoire, ni dans le panel ni dans le worker.
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
    if (!row) throw new Error(`archive ${archiveId} : morceau ${kind}#${seq} manquant`);
    yield row.data;
  }
}

/** Efface les morceaux d'un type — avant de réécrire l'archive propre, par exemple. */
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
 * Lue et refaite : l'archive propre (`tree`) est rangée, les octets reçus ne
 * servent plus et s'effacent.
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

/** Refusée : on garde la raison, pas les octets. */
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

/** Un déploiement en cours construit-il cette archive ? Alors elle ne s'efface pas. */
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
 * Ne garde que les `keep` archives les plus récentes d'une application, et
 * efface les envois restés en cours depuis plus d'une heure. Une archive qu'un
 * déploiement en cours construit est épargnée. Rend ce qui a été effacé.
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
