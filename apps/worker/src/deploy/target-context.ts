import { usableRuntimes } from '@pupitre/core';
import type { TargetContext } from '@pupitre/core/drivers';
import { connect, type SshSession } from '@pupitre/core/ssh';
import { getTargetSecret } from '@pupitre/db';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { sshTargetOf } from './ssh-target.js';

export type OpenedTarget = {
  session: SshSession;
  ctx: TargetContext;
  runtimes: Array<'docker' | 'k3s'>;
  name: string;
};

/**
 * Ouvre une session SSH vers une cible, sans aucun déploiement en tête.
 *
 * Pendant de `openDeploymentContext()`, pour le contexte de cible. Comme lui,
 * c'est un des rares endroits où un credential est déchiffré, et il ne quitte
 * pas la portée de cette fonction.
 */
export async function openTargetContext(targetId: string): Promise<OpenedTarget> {
  const record = await getTargetSecret(targetId);
  if (!record) throw new Error(`Cible « ${targetId} » introuvable`);

  const { target } = record;
  const session = await connect(sshTargetOf(record), { logger });

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
    },
  };
}
