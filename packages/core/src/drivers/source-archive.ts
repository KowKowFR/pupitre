import { posix } from 'node:path';
import { exec, upload } from '../ssh/client.js';
import type { SshSession } from '../ssh/client.js';
import { DriverError, type LogSink, type RuntimeKind, type SourceArchive } from './types.js';
import type { UiLanguage } from '../i18n.js';
import { shellQuote } from '../shell.js';
import { driverSay } from './messages.js';

/** Unpacking a large repository takes time; beyond this, something is wrong. */
const EXTRACT_TIMEOUT_MS = 5 * 60_000;

/**
 * The release folder where a linked repository's code is unpacked — **apart**
 * from what Pupitre places there itself (`compose.yml`, `.env`, `k8s/`).
 *
 * At the root, the repository mixed with the control files: a
 * `compose.override.yml` was merged by Compose (privileged container, machine
 * disk mounted), a `.env` changed the project's name, a `k8s/` folder was
 * applied to the cluster with Pupitre's rights. A repository only carries the
 * AppSpec and the code to build: it has nothing to say about the rest.
 */
export const SOURCE_DIR = 'source';

/**
 * A service's build context, relative to the release. The AppSpec's is relative
 * to the code's root: the repository's, when there is one.
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
 * Places the source code archive and unpacks it into the release's `source/`,
 * emptied first: a release of the same version redeployed keeps nothing of the
 * old code.
 *
 * Shared by both drivers: unpacking an archive into a folder does not depend on
 * the engine that will start the containers. Files keep their execute
 * permissions but not their original owner (`--no-same-owner`): they belong to
 * the deployment account, like the rest of the release.
 */
export async function extractSourceArchive(
  session: SshSession,
  release: string,
  archive: SourceArchive,
  onLog: LogSink,
  runtime: RuntimeKind,
  language: UiLanguage,
): Promise<void> {
  const say = driverSay(language);
  const remote = `${release}/.pupitre-source.tar.gz`;
  const directory = `${release}/${SOURCE_DIR}`;
  onLog(say('source.depositing', { dir: SOURCE_DIR }));
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
    onLog(say('source.extractFailed.log', { detail }));
    throw new DriverError(say('source.extractFailed', { detail }), runtime, 'upload');
  }
  onLog(say('source.extracted'));
}
