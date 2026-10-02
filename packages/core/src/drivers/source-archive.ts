import { posix } from 'node:path';
import { exec, upload } from '../ssh/client.js';
import type { SshSession } from '../ssh/client.js';
import { DriverError, type LogSink, type RuntimeKind, type SourceArchive } from './types.js';
import { shellQuote } from '../shell.js';

/** Décompresser un gros dépôt prend du temps ; au-delà, quelque chose ne va pas. */
const EXTRACT_TIMEOUT_MS = 5 * 60_000;

/**
 * Le dossier de la release où le code d'un dépôt lié est décompressé — **à
 * part** de ce que Pupitre y dépose lui-même (`compose.yml`, `.env`, `k8s/`).
 *
 * À la racine, le dépôt se mêlait aux fichiers de pilotage : un
 * `compose.override.yml` était fusionné par Compose (conteneur privilégié,
 * disque de la machine monté), un `.env` changeait le nom du projet, un dossier
 * `k8s/` était appliqué sur le cluster avec les droits de Pupitre. Un dépôt ne
 * porte que l'AppSpec et le code à construire : il n'a rien à dire du reste.
 */
export const SOURCE_DIR = 'source';

/**
 * Le contexte de construction d'un service, relatif à la release. Celui de
 * l'AppSpec est relatif à la racine du code : du dépôt, quand il y en a un.
 */
export function buildContextPath(context: string, sourceInRelease: boolean | undefined): string {
  if (!sourceInRelease) return context;
  const clean = posix
    .normalize(context)
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '');
  return clean === '.' || clean === '' ? SOURCE_DIR : `${SOURCE_DIR}/${clean}`;
}

/**
 * Dépose l'archive du code source et la décompresse dans `source/` de la
 * release, vidé d'abord : une release de même version redéployée ne garde rien
 * de l'ancien code.
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
  const directory = `${release}/${SOURCE_DIR}`;
  onLog(`dépôt du code source (archive du commit) dans ${SOURCE_DIR}/`);
  await upload(session, archive.localPath, remote);

  const result = await exec(
    session,
    `rm -rf ${shellQuote(directory)} && mkdir -p ${shellQuote(directory)} && ` +
      `tar -xzf ${shellQuote(remote)} -C ${shellQuote(directory)} ` +
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
