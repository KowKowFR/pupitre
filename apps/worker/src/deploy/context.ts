import {
  decrypt,
  intersectPortRanges,
  parseAppSpec,
  type PortRange,
} from '@tp/core';
import type { DriverContext } from '@tp/core/drivers';
import { connect, disconnect, type SshSession, type SshTarget } from '@tp/core/ssh';
import { createPortAllocator, getDeploymentForRun, getTargetSecret, type Deployment } from '@tp/db';
import { env } from '../env.js';
import { logger } from '../logger.js';

/**
 * Ouverture d'un contexte driver pour un déploiement existant.
 *
 * Extrait des handlers de déploiement au jalon 8 : rollback, destroy, scan
 * périodique, healthcheck périodique et purge des versions ont tous besoin du
 * même contexte, et aucun d'eux ne rejoue le pipeline. Le dupliquer aurait
 * garanti qu'un jour l'un des cinq oublie l'intersection des plages de ports.
 *
 * C'est le seul endroit — avec le preflight — où un credential est déchiffré,
 * et il ne quitte pas la portée de cette fonction.
 */

export type OpenedContext = {
  deployment: Deployment;
  session: SshSession;
  ctx: DriverContext;
};

export async function openDeploymentContext(deploymentId: string): Promise<OpenedContext> {
  const record = await getDeploymentForRun(deploymentId);
  if (!record) throw new Error(`Déploiement « ${deploymentId} » introuvable`);

  const { deployment } = record;
  const spec = parseAppSpec(deployment.appSpec);

  const secret = await getTargetSecret(deployment.targetId);
  if (!secret) throw new Error(`Cible « ${deployment.targetId} » introuvable`);

  const credential = decrypt(secret.encryptedCredential);
  const sshTarget: SshTarget = {
    host: secret.target.host,
    port: secret.target.port,
    username: secret.target.sshUser,
    sudoMethod: secret.target.sudoMethod,
    credentials:
      secret.target.authMethod === 'key'
        ? { authMethod: 'key', privateKey: credential }
        : { authMethod: 'password', password: credential },
  };

  const session = await connect(sshTarget, { logger });

  const previous = deployment.previousDeploymentId
    ? await getDeploymentForRun(deployment.previousDeploymentId)
    : null;

  // La plage de la cible, resserrée par celle du worker : une VM peut annoncer
  // 30000-32767 alors que le pare-feu n'en ouvre que dix.
  const targetRange: PortRange = {
    min: secret.target.portRangeStart,
    max: secret.target.portRangeEnd,
  };
  const portRange = intersectPortRanges(targetRange, env.DRIVER_PORT_RANGE) ?? targetRange;

  return {
    deployment,
    session,
    ctx: {
      spec,
      target: {
        id: secret.target.id,
        name: secret.target.name,
        host: secret.target.host,
        rootPath: env.DRIVER_ROOT_PATH,
      },
      deployment: {
        id: deployment.id,
        version: spec.version,
        sequence: deployment.version,
      },
      sshSession: session,
      appSlug: spec.name,
      applicationId: deployment.applicationId,
      ...(previous
        ? {
            previousDeployment: {
              id: previous.deployment.id,
              version: parseAppSpec(previous.deployment.appSpec).version,
              sequence: previous.deployment.version,
            },
          }
        : {}),
      portAllocator: createPortAllocator(),
      portRange,
    },
  };
}

export { disconnect };
