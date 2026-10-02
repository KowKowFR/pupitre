import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppSpec } from '@pupitre/core';
import type { SourceArchive } from '@pupitre/core/drivers';
import { SOURCE_ARCHIVE_MAX_BYTES } from '@pupitre/core/sources';
import { getApplicationSource, type Deployment } from '@pupitre/db';
import { getSourceProvider } from './provider.js';

/**
 * L'archive du commit d'un run, téléchargée juste avant l'étape `upload`.
 *
 * Seulement si un service se construit : une spec qui ne référence que des
 * images n'a pas besoin du code — c'est le cas d'un dépôt dont la CI publie
 * déjà les images. L'archive vit dans un dossier temporaire du worker, effacé
 * dès le dépôt terminé ; elle ne reste nulle part.
 */
/**
 * Ce run apporte-t-il le code d'un dépôt ? La même réponse décide du
 * téléchargement ci-dessous et, dès le rendu, de l'endroit où les contextes de
 * construction se résolvent (`DriverContext.sourceInRelease`).
 */
export function carriesSourceCode(deployment: Deployment, spec: AppSpec): boolean {
  return (
    Boolean(deployment.sourceSha && deployment.sourceRepository) &&
    spec.services.some((service) => service.source.type === 'dockerfile')
  );
}

export async function prepareSourceArchive(
  deployment: Deployment,
  spec: AppSpec,
  onLog: (line: string) => void,
): Promise<{ archive: SourceArchive; cleanup: () => Promise<void> } | null> {
  if (!carriesSourceCode(deployment, spec)) return null;
  if (!deployment.sourceSha || !deployment.sourceRepository) return null;

  const source = deployment.sourceId ? await getApplicationSource(deployment.sourceId) : null;
  if (!source) {
    throw new Error(
      `la liaison au dépôt ${deployment.sourceRepository} a été supprimée : ` +
        'impossible de récupérer le code du commit à construire',
    );
  }
  const access = await getSourceProvider();
  if (!access) {
    throw new Error('aucune GitHub App connectée : impossible de récupérer le code du commit');
  }

  const directory = await mkdtemp(join(tmpdir(), 'pupitre-source-'));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  const localPath = join(directory, 'source.tar.gz');
  onLog(`téléchargement de ${source.repository}@${deployment.sourceSha.slice(0, 7)}`);
  try {
    const { bytes } = await access.provider.downloadArchive(
      { fullName: source.repository, installationId: source.installationId },
      deployment.sourceSha,
      localPath,
      SOURCE_ARCHIVE_MAX_BYTES,
    );
    onLog(`archive reçue (${(bytes / 1024 / 1024).toFixed(1)} Mio)`);
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { archive: { localPath, stripComponents: 1 }, cleanup };
}
