import { intersectPortRanges, parseAppSpec, type PortRange } from '@pupitre/core';
import type { DriverContext, SecretResolver } from '@pupitre/core/drivers';
import { connect, type ConnectOptions, type SshSession } from '@pupitre/core/ssh';
import {
  createPortAllocator,
  ensureApplicationSecrets,
  getDeploymentForRun,
  getTargetSecret,
  resolveApplicationSecrets,
  type Deployment,
} from '@pupitre/db';
import { env } from '../env.js';
import { instanceLanguage } from '../language.js';
import { logger } from '../logger.js';
import { workerSay } from '../messages.js';
import { sshTargetOf } from './ssh-target.js';

/**
 * Opening a driver context for an existing deployment.
 *
 * Extracted from the deployment handlers: rollback, destroy, periodic scan,
 * periodic healthcheck and version purge all need the same context, and none of
 * them replays the pipeline. Duplicating it would have guaranteed that one day
 * one of the five forgets the port ranges' intersection.
 *
 * It is the only place — with the preflight — where a credential is decrypted,
 * and it does not leave this function's scope.
 */

/**
 * Provides the driver with the values of the secrets declared by the AppSpec.
 *
 * Attached to the **application**, never to the deployment: that is what makes
 * the value stable from one release to the next. Regenerating the PostgreSQL
 * password at redeploy would break the existing database, whose volume carries
 * the old one — see the comment of `schema/secrets.ts`.
 *
 * `ensureApplicationSecrets()` first: an AppSpec that declares one more secret
 * (or an application created before the store existed) sees it created here,
 * with a generated value. A name that would still not be found is absent from
 * the result, and the render fails by naming it.
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
 * `connect` bounds the session opening attempt.
 *
 * The default — three attempts, fifteen seconds each, plus backoff — is right
 * for a deployment: a struggling machine must not fail a release. It is wrong
 * for a cascading deletion on a target known to be off: three dead machines make
 * two and a half minutes of waiting before the first word about what blocks.
 */
/** The connection's options — its language is the instance's, set here. */
export type OpenContextOptions = { connect?: Omit<ConnectOptions, 'language'> };

export async function openDeploymentContext(
  deploymentId: string,
  options: OpenContextOptions = {},
): Promise<OpenedContext> {
  const language = await instanceLanguage();
  const say = workerSay(language);

  const record = await getDeploymentForRun(deploymentId);
  if (!record) throw new Error(say('notFound.deployment', { id: deploymentId }));

  const { deployment } = record;
  const spec = parseAppSpec(deployment.appSpec);

  const secret = await getTargetSecret(deployment.targetId);
  if (!secret) throw new Error(say('notFound.target', { id: deployment.targetId }));

  const session = await connect(sshTargetOf(secret), { logger, language, ...options.connect });

  const previous = deployment.previousDeploymentId
    ? await getDeploymentForRun(deployment.previousDeploymentId)
    : null;

  // The target's range, narrowed by the worker's: a VM can announce 30000-32767
  // while the firewall only opens ten of them.
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
      language,
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
