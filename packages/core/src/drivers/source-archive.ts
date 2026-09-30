import { exec, upload } from '../ssh/client.js';
import type { SshSession } from '../ssh/client.js';
import { DriverError, type LogSink, type RuntimeKind, type SourceArchive } from './types.js';

/** Décompresser un gros dépôt prend du temps ; au-delà, quelque chose ne va pas. */
const EXTRACT_TIMEOUT_MS = 5 * 60_000;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Dépose l'archive du code source et la décompresse à la racine de la release.
 *
 * Commun aux deux drivers : décompresser une archive dans un dossier ne dépend
 * pas du moteur qui lancera les conteneurs. Les fichiers gardent leurs droits
 * d'exécution mais pas leur propriétaire d'origine (`--no-same-owner`) : ils
 * appartiennent au compte de déploiement, comme le reste de la release.
 */
export async function extractSourceArchive(
  session: SshSession,
  release: string,
  archive: SourceArchive,
  onLog: LogSink,
  runtime: RuntimeKind,
): Promise<void> {
  const remote = `${release}/.pupitre-source.tar.gz`;
  onLog('dépôt du code source (archive du commit)');
  await upload(session, archive.localPath, remote);

  const result = await exec(
    session,
    `tar -xzf ${shellQuote(remote)} -C ${shellQuote(release)} ` +
      `--strip-components=${archive.stripComponents} --no-same-owner && rm -f ${shellQuote(remote)}`,
    { timeout: EXTRACT_TIMEOUT_MS },
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim().split('\n')[0] || `code ${result.code}`;
    onLog(`✗ extraction du code source : ${detail}`);
    throw new DriverError(`Extraction du code source impossible : ${detail}`, runtime, 'upload');
  }
  onLog('✓ code source extrait');
}
