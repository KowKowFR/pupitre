import {
  decrypt,
  intersectPortRanges,
  parseAppSpec,
  type PortRange,
} from '@tp/core';
import type { DriverContext, SecretResolver } from '@tp/core/drivers';
import {
  connect,
  disconnect,
  type ConnectOptions,
  type SshSession,
  type SshTarget,
} from '@tp/core/ssh';
import {
  createPortAllocator,
  ensureApplicationSecrets,
  getDeploymentForRun,
  getTargetSecret,
  resolveApplicationSecrets,
  type Deployment,
} from '@tp/db';
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

/**
 * Fournit au driver les valeurs des secrets déclarés par l'AppSpec.
 *
 * Attaché à l'**application**, jamais au déploiement : c'est ce qui rend la
 * valeur stable d'une mise en ligne à la suivante. Régénérer le mot de passe
 * PostgreSQL au redéploiement casserait la base existante, dont le volume porte
 * l'ancien — voir le commentaire de `schema/secrets.ts`.
 *
 * `ensureApplicationSecrets()` d'abord : une AppSpec qui déclare un secret de
 * plus (ou une application créée avant l'existence du magasin) le voit créé
 * ici, avec une valeur générée. Un nom qui resterait malgré tout introuvable
 * est absent du résultat, et le rendu échoue en le nommant.
 */
export function secretResolverFor(applicationId: string): SecretResolver {
  return async (names) => {
    if (names.length === 0) return {};
    await ensureApplicationSecrets(applicationId, names);
    return resolveApplicationSecrets(applicationId, names);
  };
}

export type OpenedContext = {
  deployment: Deployment;
  session: SshSession;
  ctx: DriverContext;
};

/**
 * `connect` borne la tentative d'ouverture de session.
 *
 * Le défaut — trois essais, quinze secondes chacune, plus le backoff — est le
 * bon pour un déploiement : une machine qui rame ne doit pas faire échouer une
 * mise en ligne. Il est le mauvais pour une suppression en cascade sur une
 * cible qu'on sait éteinte : trois machines mortes, c'est deux minutes et demie
 * d'attente avant le premier mot au sujet de ce qui bloque.
 */
export type OpenContextOptions = { connect?: ConnectOptions };

export async function openDeploymentContext(
  deploymentId: string,
  options: OpenContextOptions = {},
): Promise<OpenedContext> {
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

  const session = await connect(sshTarget, { logger, ...options.connect });

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
      resolveSecrets: secretResolverFor(deployment.applicationId),
    },
  };
}

export { disconnect };
