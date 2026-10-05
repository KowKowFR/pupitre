import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SOURCE_ARCHIVES_KEPT,
  errorMessage,
  expectedDockerfiles,
  safeParseAppSpec,
  sourceArchiveInspectJobDataSchema,
} from '@pupitre/core';
import { SourceArchiveRejected, inspectSourceArchive } from '@pupitre/core/source-upload';
import {
  getApplication,
  getSourceArchive,
  logAudit,
  markSourceArchiveReady,
  markSourceArchiveRejected,
  pruneSourceArchives,
} from '@pupitre/db';
import type { Job } from 'bullmq';
import { logger } from '../logger.js';
import { exportArchiveChunks, importArchiveChunks } from '../sources/stored-archive.js';

/**
 * An uploaded code archive, read by the worker.
 *
 * The route stored the received bytes and returned; here, we read them again
 * entry by entry (`inspectSourceArchive`), refuse what would leave the folder,
 * and store instead the clean archive — the only one a deployment will place.
 * The received bytes are erased in both cases.
 *
 * The job can be replayed: it does nothing with an archive that is no longer
 * waiting.
 */
export async function handleSourceArchiveInspect(
  job: Job,
): Promise<{ archiveId: string; status: string; rejection?: string }> {
  const data = sourceArchiveInspectJobDataSchema.parse(job.data);
  const archive = await getSourceArchive(data.archiveId);
  if (!archive || archive.status !== 'pending') {
    return { archiveId: data.archiveId, status: archive?.status ?? 'gone' };
  }

  const application = await getApplication(archive.applicationId);
  const parsed = application ? safeParseAppSpec(application.appSpec) : null;
  const expected = parsed?.success ? expectedDockerfiles(parsed.data).map((item) => item.path) : [];
  const log = logger.child({ archiveId: archive.id, application: application?.slug });
  const subject = {
    application: application?.slug ?? null,
    applicationId: archive.applicationId,
    name: archive.name,
    sha256: archive.sha256,
  };

  let outcome: { archiveId: string; status: string; rejection?: string } = {
    archiveId: archive.id,
    status: 'ready',
  };
  const directory = await mkdtemp(join(tmpdir(), 'pupitre-inspect-'));
  try {
    const received = join(directory, 'received');
    const output = join(directory, 'source.tar.gz');
    await exportArchiveChunks(archive.id, 'upload', received);

    try {
      const report = await inspectSourceArchive(received, archive.format, output, {
        expected,
        workDir: directory,
      });
      const archiveBytes = await importArchiveChunks(archive.id, 'tree', output);
      await markSourceArchiveReady(archive.id, { archiveBytes, report });
      log.info({ files: report.files, bytes: report.unpackedBytes }, 'code archive ready');
      await logAudit({
        actorId: data.actorId,
        action: 'source_archive.ready',
        resourceType: 'source_archive',
        resourceId: archive.id,
        after: {
          ...subject,
          files: report.files,
          unpackedBytes: report.unpackedBytes,
          strippedRoot: report.strippedRoot,
          skippedEntries: report.skippedEntries,
          dockerfiles: report.dockerfiles.length,
        },
        ip: data.ip,
      });
    } catch (error) {
      if (!(error instanceof SourceArchiveRejected)) throw error;
      await markSourceArchiveRejected(archive.id, { rejection: error.code, detail: error.detail });
      log.warn({ rejection: error.code, detail: error.detail }, 'code archive refused');
      await logAudit({
        actorId: data.actorId,
        action: 'source_archive.rejected',
        resourceType: 'source_archive',
        resourceId: archive.id,
        after: { ...subject, rejection: error.code, detail: error.detail },
        ip: data.ip,
      });
      outcome = { archiveId: archive.id, status: 'rejected', rejection: error.code };
    }
  } catch (error) {
    // A failure (database, disk), not a refusal: the archive stays pending, and the
    // worker's log says why. A new upload will replace it.
    log.error({ err: error }, `archive could not be read: ${errorMessage(error)}`);
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  // We only keep the last ones, refused ones included: an archive a deployment in
  // progress is building is spared.
  const removed = await pruneSourceArchives(archive.applicationId, SOURCE_ARCHIVES_KEPT);
  if (removed.length > 0) {
    await logAudit({
      actorId: null,
      action: 'source_archive.pruned',
      resourceType: 'application',
      resourceId: archive.applicationId,
      after: {
        application: application?.slug ?? null,
        kept: SOURCE_ARCHIVES_KEPT,
        removed: removed.map((item) => item.name),
      },
      ip: null,
    });
  }
  return outcome;
}
