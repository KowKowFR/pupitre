import 'server-only';
import {
  SOURCE_DEPLOY_JOB,
  SOURCE_POLL_JOB,
  sourceDeployJobDataSchema,
  sourcePollJobDataSchema,
  usableRuntimes,
  type SourceDeployJobData,
  type SourcePollJobData,
} from '@pupitre/core';
import {
  getApplication,
  getApplicationSource,
  getTarget,
  type ApplicationSourceInput,
  type ApplicationSourceView,
} from '@pupitre/db';
import { sources as messages } from '@/i18n/messages/sources';
import { ConflictError, HttpError, NotFoundError, msg } from '@/lib/errors';
import { getSupervisionQueue } from '@/lib/supervision-queue';

/**
 * Ce que partagent les routes des liaisons : retrouver une liaison sous son
 * application, vérifier des cibles, enfiler une tâche.
 */

/** La liaison, à condition qu'elle appartienne bien à cette application. */
export async function sourceOf(
  applicationId: string,
  sourceId: string,
): Promise<ApplicationSourceView> {
  const source = await getApplicationSource(sourceId);
  if (!source || source.applicationId !== applicationId) {
    throw new NotFoundError(msg(messages, 'error.sourceNotFound', { id: sourceId }));
  }
  return source;
}

export async function assertApplication(applicationId: string) {
  const application = await getApplication(applicationId);
  if (!application) {
    throw new NotFoundError(msg(messages, 'error.applicationNotFound', { id: applicationId }));
  }
  return application;
}

/** Chaque cible existe, et son preflight a vu le runtime demandé. */
export async function assertTargets(list: ApplicationSourceInput['targets']): Promise<void> {
  for (const entry of list) {
    const target = await getTarget(entry.targetId);
    if (!target) {
      throw new NotFoundError(msg(messages, 'error.targetNotFound', { id: entry.targetId }));
    }
    if (!usableRuntimes(target.runtimesAvailable).includes(entry.runtime)) {
      throw new ConflictError(
        msg(messages, 'error.runtimeUnavailable', { runtime: entry.runtime, target: target.name }),
      );
    }
  }
}

export async function enqueuePoll(data: Partial<SourcePollJobData>): Promise<string> {
  const job = await getSupervisionQueue().add(
    SOURCE_POLL_JOB,
    sourcePollJobDataSchema.parse(data),
    {
      attempts: 1,
    },
  );
  if (!job.id) throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.enqueueFailed'));
  return job.id;
}

export async function enqueueSourceDeploy(data: SourceDeployJobData): Promise<string> {
  const job = await getSupervisionQueue().add(
    SOURCE_DEPLOY_JOB,
    sourceDeployJobDataSchema.parse(data),
    { attempts: 1 },
  );
  if (!job.id) throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.enqueueFailed'));
  return job.id;
}

/** Une liaison, telle que les routes la rendent. */
export function sourceJson(source: ApplicationSourceView) {
  return {
    id: source.id,
    repository: source.repository,
    installationId: source.installationId,
    branch: source.branch,
    specPath: source.specPath,
    watchPaths: source.watchPaths,
    mode: source.mode,
    enabled: source.enabled,
    lastSeenSha: source.lastSeenSha,
    lastCheckedAt: source.lastCheckedAt?.toISOString() ?? null,
    lastChangeAt: source.lastChangeAt?.toISOString() ?? null,
    lastError: source.lastError,
    targets: source.targets,
    pendingProposals: source.pendingProposals,
  };
}
