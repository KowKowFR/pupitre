import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOURCE_ARCHIVES_KEPT, type AppSpec, type UiLanguage } from '@pupitre/core';
import type { SourceArchive } from '@pupitre/core/drivers';
import { SOURCE_ARCHIVE_MAX_BYTES } from '@pupitre/core/sources';
import { getApplicationSource, getSourceArchive, type Deployment } from '@pupitre/db';
import { workerSay, type WorkerSay } from '../messages.js';
import { providerForConnection } from './provider.js';
import { exportArchiveChunks } from './stored-archive.js';

/**
 * A run's commit archive, downloaded just before the `upload` step.
 *
 * Only if a service is built: a spec that only references images does not need
 * the code — the case of a repository whose CI already publishes the images.
 * The archive lives in a temporary folder of the worker, erased as soon as the
 * upload is done; it stays nowhere.
 */
/**
 * Does this run bring code — a commit's, or an uploaded archive? The same answer
 * decides the download below and, from the render on, where the build contexts
 * resolve (`DriverContext.sourceInRelease`).
 */
export function carriesSourceCode(deployment: Deployment, spec: AppSpec): boolean {
  const code =
    Boolean(deployment.sourceSha && deployment.sourceRepository) ||
    Boolean(deployment.sourceArchiveSha256);
  return code && spec.services.some((service) => service.source.type === 'dockerfile');
}

/**
 * A run's uploaded archive, read back from the database: the clean archive the
 * worker remade on reception, never the uploaded bytes.
 */
async function storedArchive(
  deployment: Deployment,
  onLog: (line: string) => void,
  say: WorkerSay,
): Promise<{ archive: SourceArchive; cleanup: () => Promise<void> }> {
  const name = deployment.sourceArchiveName ?? 'archive';
  const stored = deployment.sourceArchiveId
    ? await getSourceArchive(deployment.sourceArchiveId)
    : null;
  if (!stored || stored.status !== 'ready' || stored.sha256 !== deployment.sourceArchiveSha256) {
    throw new Error(say('source.archiveGone', { name, kept: SOURCE_ARCHIVES_KEPT }));
  }

  const directory = await mkdtemp(join(tmpdir(), 'pupitre-source-'));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  const localPath = join(directory, 'source.tar.gz');
  try {
    const bytes = await exportArchiveChunks(stored.id, 'tree', localPath);
    onLog(
      say('source.archiveRead', {
        name,
        sha: stored.sha256?.slice(0, 12) ?? '?',
        size: (bytes / 1024 / 1024).toFixed(1),
      }),
    );
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { archive: { localPath, stripComponents: 1 }, cleanup };
}

export async function prepareSourceArchive(
  deployment: Deployment,
  spec: AppSpec,
  onLog: (line: string) => void,
  language: UiLanguage,
): Promise<{ archive: SourceArchive; cleanup: () => Promise<void> } | null> {
  const say = workerSay(language);
  if (!carriesSourceCode(deployment, spec)) return null;
  if (deployment.sourceArchiveSha256) return storedArchive(deployment, onLog, say);
  if (!deployment.sourceSha || !deployment.sourceRepository) return null;

  const source = deployment.sourceId ? await getApplicationSource(deployment.sourceId) : null;
  if (!source) {
    throw new Error(say('source.linkGone', { repository: deployment.sourceRepository }));
  }
  const access = await providerForConnection(source.connectionId);
  if (!access) {
    throw new Error(say('source.connectionGone', { repository: source.repository }));
  }

  const directory = await mkdtemp(join(tmpdir(), 'pupitre-source-'));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  const localPath = join(directory, 'source.tar.gz');
  onLog(
    say('source.downloading', {
      repository: source.repository,
      sha: deployment.sourceSha.slice(0, 7),
    }),
  );
  try {
    const { bytes } = await access.provider.downloadArchive(
      { fullName: source.repository, installationId: source.installationId },
      deployment.sourceSha,
      localPath,
      SOURCE_ARCHIVE_MAX_BYTES,
    );
    onLog(say('source.received', { size: (bytes / 1024 / 1024).toFixed(1) }));
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { archive: { localPath, stripComponents: 1 }, cleanup };
}
