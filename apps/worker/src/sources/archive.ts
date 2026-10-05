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
 * L'archive du commit d'un run, téléchargée juste avant l'étape `upload`.
 *
 * Seulement si un service se construit : une spec qui ne référence que des
 * images n'a pas besoin du code — c'est le cas d'un dépôt dont la CI publie
 * déjà les images. L'archive vit dans un dossier temporaire du worker, effacé
 * dès le dépôt terminé ; elle ne reste nulle part.
 */
/**
 * Ce run apporte-t-il du code — celui d'un commit, ou une archive téléversée ?
 * La même réponse décide du téléchargement ci-dessous et, dès le rendu, de
 * l'endroit où les contextes de construction se résolvent
 * (`DriverContext.sourceInRelease`).
 */
export function carriesSourceCode(deployment: Deployment, spec: AppSpec): boolean {
  const code =
    Boolean(deployment.sourceSha && deployment.sourceRepository) ||
    Boolean(deployment.sourceArchiveSha256);
  return code && spec.services.some((service) => service.source.type === 'dockerfile');
}

/**
 * L'archive téléversée d'un run, relue depuis la base : l'archive propre que
 * le worker a refaite à la réception, jamais les octets envoyés.
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
