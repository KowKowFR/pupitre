import 'server-only';
import {
  SOURCE_DEPLOY_JOB,
  SOURCE_POLL_JOB,
  SOURCE_PROVIDER_LABELS,
  sourceDeployJobDataSchema,
  sourcePollJobDataSchema,
  usableRuntimes,
  type SourceDeployJobData,
  type SourcePollJobData,
  type SourceProvider,
  type SourceProviderKind,
  type SourceRepository,
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
import { providerError, sourceProvider } from '@/lib/sources';
import { getSupervisionQueue } from '@/lib/supervision-queue';

/**
 * What the links' routes share: finding a link under its application, checking
 * targets, queuing a job.
 */

/** The link, provided that it does belong to this application. */
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

/** Each target exists, and its preflight saw the requested runtime. */
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

/** A link, as the routes return it. */
export function sourceJson(source: ApplicationSourceView) {
  return {
    id: source.id,
    repository: source.repository,
    installationId: source.installationId,
    branch: source.branch,
    specPath: source.specPath,
    watchPaths: source.watchPaths,
    mode: source.mode,
    deployTo: source.deployTo,
    enabled: source.enabled,
    lastSeenSha: source.lastSeenSha,
    syncedSha: source.syncedSha,
    syncedAt: source.syncedAt?.toISOString() ?? null,
    lastCheckedAt: source.lastCheckedAt?.toISOString() ?? null,
    lastChangeAt: source.lastChangeAt?.toISOString() ?? null,
    lastError: source.lastError,
    targets: source.targets,
    pendingProposals: source.pendingProposals,
  };
}

/** The client of a connected provider — otherwise 409, naming it. */
export async function connectedProvider(kind: SourceProviderKind) {
  const access = await sourceProvider(kind);
  if (!access) {
    throw new ConflictError(
      msg(messages, 'error.notConnected', { provider: SOURCE_PROVIDER_LABELS[kind] }),
    );
  }
  return access;
}

/**
 * The repository, as the provider shows it to Pupitre — checked with it: a
 * repository (and, at GitHub, an installation identifier) coming from a form is
 * not taken at its word.
 */
export async function accessibleRepository(
  provider: SourceProvider,
  repository: string,
  installationId: number | null,
): Promise<SourceRepository> {
  const repositories = await provider.listRepositories().catch(providerError);
  const found = repositories.find(
    (repo) =>
      repo.fullName === repository &&
      (provider.kind !== 'github' || repo.installationId === installationId),
  );
  if (!found) {
    throw new ConflictError(
      msg(messages, 'error.repositoryUnavailable', {
        repository,
        provider: SOURCE_PROVIDER_LABELS[provider.kind],
      }),
    );
  }
  return found;
}
