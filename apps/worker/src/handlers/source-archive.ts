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
 * Une archive de code téléversée, lue par le worker.
 *
 * La route a rangé les octets reçus et rendu la main ; ici, on les relit
 * entrée par entrée (`inspectSourceArchive`), on refuse ce qui sortirait du
 * dossier, et l'on range à la place l'archive propre — la seule qu'un
 * déploiement déposera. Les octets reçus s'effacent dans les deux cas.
 *
 * La tâche est rejouable : elle ne fait rien d'une archive qui n'attend plus.
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
      log.info({ files: report.files, bytes: report.unpackedBytes }, 'archive de code prête');
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
      log.warn({ rejection: error.code, detail: error.detail }, 'archive de code refusée');
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
    // Une panne (base, disque), pas un refus : l'archive reste en attente, et
    // le journal du worker dit pourquoi. Un nouvel envoi la remplacera.
    log.error({ err: error }, `lecture de l'archive impossible : ${errorMessage(error)}`);
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  // On ne garde que les dernières, refusées comprises : une archive que
  // construit un déploiement en cours est épargnée.
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
