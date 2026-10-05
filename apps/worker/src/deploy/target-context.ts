import { usableRuntimes } from '@pupitre/core';
import type { TargetContext } from '@pupitre/core/drivers';
import { connect, type SshSession } from '@pupitre/core/ssh';
import { getTargetSecret } from '@pupitre/db';
import { env } from '../env.js';
import { instanceLanguage } from '../language.js';
import { logger } from '../logger.js';
import { workerSay } from '../messages.js';
import { sshTargetOf } from './ssh-target.js';

export type OpenedTarget = {
  session: SshSession;
  ctx: TargetContext;
  runtimes: Array<'docker' | 'k3s'>;
  name: string;
};

/**
 * Opens an SSH session to a target, without any deployment in mind.
 *
 * The counterpart of `openDeploymentContext()`, for the target context. Like it,
 * it is one of the rare places where a credential is decrypted, and it does not
 * leave this function's scope.
 */
export async function openTargetContext(targetId: string): Promise<OpenedTarget> {
  const language = await instanceLanguage();
  const record = await getTargetSecret(targetId);
  if (!record) throw new Error(workerSay(language)('notFound.target', { id: targetId }));

  const { target } = record;
  const session = await connect(sshTargetOf(record), { logger, language });

  return {
    session,
    name: target.name,
    runtimes: usableRuntimes(target.runtimesAvailable),
    ctx: {
      target: {
        id: target.id,
        name: target.name,
        host: target.host,
        rootPath: env.DRIVER_ROOT_PATH,
      },
      sshSession: session,
      language,
    },
  };
}
