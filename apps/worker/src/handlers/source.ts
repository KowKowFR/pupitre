import {
  classifySpecChange,
  defaultWatchPaths,
  errorMessage,
  parseAppSpec,
  parseSourceSpec,
  sourceDeployJobDataSchema,
  sourcePollJobDataSchema,
  touchesWatchPaths,
  UI_LANGUAGES,
  type AppSpec,
  type RepositoryRef,
  type SourceProvider,
} from '@pupitre/core';
import {
  claimSourceCommit,
  createSourceProposal,
  getApplication,
  getApplicationSource,
  getSourceProposal,
  listEnabledSources,
  logAudit,
  recordSourceCheck,
  type ApplicationSourceView,
} from '@pupitre/db';
import type { Job } from 'bullmq';
import { instanceLanguage } from '../language.js';
import { logger } from '../logger.js';
import { workerSay } from '../messages.js';
import {
  bindingsFor,
  deployFromSource,
  skippedSummary,
  syncFromSource,
} from '../sources/deploy.js';
import { providerForConnection } from '../sources/provider.js';
import { panelUrl, reportCommitStatus, statusLanguage, statusText } from '../sources/status.js';

/**
 * Linked repositories, worker side.
 *
 * `source:poll` asks each active link the same question every minute: "has the
 * branch's last commit changed?". The answer costs one HTTP call, and almost
 * nothing when it is "no" (ETag → 304). When it is "yes", in order:
 *
 *   1. does the commit concern the application? (watched paths, monorepo)
 *   2. is its `pupitre.json` valid?
 *   3. the commit is **reserved** — a conditional write in the database: two
 *      overlapping passes do not deploy twice;
 *   4. depending on the link's mode, it goes out, or it waits for approval.
 *
 * A link's very first check deploys nothing: it notes the head commit. Linking a
 * repository must not redeploy what already runs — "Deploy this commit" is there
 * for that.
 */

function repoOf(source: ApplicationSourceView): RepositoryRef {
  return { fullName: source.repository, installationId: source.installationId };
}

type ReadSpec =
  | { ok: true; spec: AppSpec }
  | { ok: false; issues: string[] };

/** The commit's `pupitre.json`, validated, under the linked application's name. */
async function readSpec(
  provider: SourceProvider,
  source: ApplicationSourceView,
  sha: string,
  applicationSlug: string,
): Promise<ReadSpec> {
  const language = await instanceLanguage();
  const content = await provider.readFile(repoOf(source), sha, source.specPath);
  if (content === null) {
    return {
      ok: false,
      issues: [workerSay(language)('source.missingFile', { path: source.specPath })],
    };
  }
  return parseSourceSpec(content, applicationSlug, language);
}

/** A refused `pupitre.json`: written on the link, in the log, and on the commit. */
async function rejectCommit(
  source: ApplicationSourceView,
  sha: string,
  issues: string[],
): Promise<void> {
  const error = workerSay(await instanceLanguage())('source.rejected', {
    path: source.specPath,
    sha: sha.slice(0, 7),
    issues: issues.join(' ; '),
  });
  await recordSourceCheck(source.id, { error });
  await logAudit({
    action: 'source.commit.rejected',
    resourceType: 'application_source',
    resourceId: source.id,
    after: { repository: source.repository, branch: source.branch, sha, issues },
  });
  const language = await statusLanguage();
  const base = panelUrl();
  await reportCommitStatus(source, sha, {
    state: 'error',
    description: statusText(language, 'invalid', { issue: issues[0] ?? '' }),
    context: 'pupitre',
    targetUrl: base ? `${base}/applications/${source.applicationId}` : null,
  });
}

/**
 * A new and relevant commit: the application takes it without being deployed, it
 * goes to its targets, or it waits for a human.
 */
async function takeCommit(
  provider: SourceProvider,
  source: ApplicationSourceView,
  sha: string,
  spec: AppSpec,
  current: AppSpec | null,
): Promise<'synced' | 'deployed' | 'proposed'> {
  // "Update only": nothing goes out, one deploys wherever one wants.
  if (source.deployTo === 'none') {
    await syncFromSource({ source, sha, spec, trigger: 'auto', actorId: null, ip: null });
    await recordSourceCheck(source.id, { error: null });
    return 'synced';
  }

  const commit = await provider.commit(repoOf(source), sha);
  const report = classifySpecChange(current, spec);
  const needsApproval =
    source.mode === 'manual' || (source.mode === 'auto_unless_infra' && report.infra);

  if (needsApproval) {
    const proposal = await createSourceProposal({
      sourceId: source.id,
      sha,
      commitMessage: commit.message,
      commitAuthor: commit.author,
      commitUrl: commit.url,
      appSpec: spec,
      reason: source.mode === 'manual' ? 'manual' : 'infra',
      changes: report.changes,
    });
    await recordSourceCheck(source.id, { error: null });
    await logAudit({
      action: 'source.commit.proposed',
      resourceType: 'application_source',
      resourceId: source.id,
      after: {
        repository: source.repository,
        branch: source.branch,
        sha,
        reason: source.mode === 'manual' ? 'manual' : 'infra',
        changes: report.changes.map((change) => change.path),
        proposalId: proposal?.id ?? null,
      },
    });
    const language = await statusLanguage();
    const base = panelUrl();
    await reportCommitStatus(source, sha, {
      state: 'pending',
      description: statusText(language, 'proposal'),
      context: 'pupitre',
      targetUrl: base ? `${base}/applications/${source.applicationId}` : null,
    });
    return 'proposed';
  }

  const bindings = await bindingsFor(source);
  if (bindings.length === 0) {
    // "Where it runs", and it runs nowhere: the version is taken, the next manual
    // deployment will carry it.
    await syncFromSource({
      source,
      sha,
      spec,
      trigger: 'auto',
      idle: true,
      actorId: null,
      ip: null,
    });
    await recordSourceCheck(source.id, { error: null });
    return 'synced';
  }
  const result = await deployFromSource({
    source,
    sha,
    spec,
    commit,
    trigger: 'auto',
    bindings,
    actorId: null,
    ip: null,
  });
  await recordSourceCheck(source.id, { error: skippedSummary(result) });
  return 'deployed';
}

async function pollSource(
  provider: SourceProvider,
  source: ApplicationSourceView,
  force: boolean,
): Promise<string> {
  const head = await provider.resolveHead(repoOf(source), source.branch, force ? null : source.lastEtag);
  if (!head.changed || head.sha === source.lastSeenSha) {
    // GitHub answered: an earlier connection error is lifted. A refused
    // pupitre.json stays so as long as the head has not changed. In either language:
    // the instance may have changed it since.
    const rejected = UI_LANGUAGES.some(
      (language) =>
        source.lastError?.startsWith(
          workerSay(language)('source.rejectedPrefix', { path: source.specPath }),
        ) ?? false,
    );
    await recordSourceCheck(source.id, {
      ...(head.changed ? { etag: head.etag } : {}),
      error: rejected ? source.lastError : null,
    });
    return 'unchanged';
  }

  // First check: we note the head, we deploy nothing.
  if (source.lastSeenSha === null) {
    await claimSourceCommit(source.id, null, head.sha, head.etag);
    await recordSourceCheck(source.id, { error: null });
    return 'baseline';
  }

  const watchPaths =
    source.watchPaths.length > 0 ? source.watchPaths : defaultWatchPaths(source.specPath);
  const compare = await provider.compare(repoOf(source), source.lastSeenSha, head.sha);
  const relevant =
    compare.kind === 'unknown' || touchesWatchPaths(compare.files, watchPaths, source.specPath);
  if (!relevant) {
    await claimSourceCommit(source.id, source.lastSeenSha, head.sha, head.etag);
    await recordSourceCheck(source.id, { error: null });
    return 'ignored';
  }

  const application = await getApplication(source.applicationId);
  if (!application) return 'unchanged';
  const read = await readSpec(provider, source, head.sha, application.slug);

  // Reserved before acting: if another pass already took it, we stop there.
  if (!(await claimSourceCommit(source.id, source.lastSeenSha, head.sha, head.etag))) {
    return 'claimed-elsewhere';
  }
  if (!read.ok) {
    await rejectCommit(source, head.sha, read.issues);
    return 'rejected';
  }

  let current: AppSpec | null = null;
  try {
    current = parseAppSpec(application.appSpec);
  } catch {
    current = null;
  }
  return takeCommit(provider, source, head.sha, read.spec, current);
}

/** `source:poll` — every active link, or a single one ("Check now"). */
export async function handleSourcePoll(job: Job): Promise<{ checked: number }> {
  const data = sourcePollJobDataSchema.parse(job.data);

  const sources = data.sourceId
    ? [await getApplicationSource(data.sourceId)].filter(
        (source): source is ApplicationSourceView => source !== null,
      )
    : await listEnabledSources();

  let checked = 0;
  for (const source of sources) {
    const log = logger.child({ sourceId: source.id, repository: source.repository });
    try {
      // Each link goes through its connection's provider: GitHub, GitLab, Gitea.
      const access = await providerForConnection(source.connectionId);
      if (!access) {
        throw new Error(workerSay(await instanceLanguage())('source.connectionRemoved'));
      }
      const outcome = await pollSource(access.provider, source, data.force);
      if (outcome !== 'unchanged') log.info({ outcome }, 'linked repository checked');
    } catch (error) {
      // A failing link does not stop the others: the error is written on it, in clear,
      // and the next minute retries.
      log.warn({ err: error }, 'repository check failed');
      await recordSourceCheck(source.id, { error: errorMessage(error) });
    }
    checked += 1;
  }
  return { checked };
}

/**
 * `source:deploy` — a human decided: deploy the branch's head, or a pending
 * commit they just approved.
 */
export async function handleSourceDeploy(job: Job): Promise<{ created: number }> {
  const data = sourceDeployJobDataSchema.parse(job.data);

  if (data.kind === 'proposal') {
    const proposal = await getSourceProposal(data.proposalId);
    if (!proposal || proposal.status !== 'approved') return { created: 0 };
    const source = await getApplicationSource(proposal.sourceId);
    if (!source) return { created: 0 };
    // Where an approved commit goes is decided now: where the application runs at
    // approval time, not when it was received.
    const bindings = await bindingsFor(source);
    if (bindings.length === 0) {
      await syncFromSource({
        source,
        sha: proposal.sha,
        spec: parseAppSpec(proposal.appSpec),
        trigger: 'proposal',
        idle: source.deployTo === 'running',
        proposalId: proposal.id,
        actorId: data.actorId,
        ip: data.ip,
      });
      return { created: 0 };
    }
    const result = await deployFromSource({
      source,
      sha: proposal.sha,
      spec: parseAppSpec(proposal.appSpec),
      commit: {
        sha: proposal.sha,
        message: proposal.commitMessage ?? '',
        author: proposal.commitAuthor,
        url: proposal.commitUrl,
      },
      trigger: 'proposal',
      bindings,
      proposalId: proposal.id,
      actorId: data.actorId,
      ip: data.ip,
    });
    await recordSourceCheck(source.id, { error: skippedSummary(result) });
    return { created: result.created.length };
  }

  const source = await getApplicationSource(data.sourceId);
  if (!source) return { created: 0 };
  const application = await getApplication(source.applicationId);
  if (!application) return { created: 0 };

  try {
    const access = await providerForConnection(source.connectionId);
    if (!access) throw new Error(workerSay(await instanceLanguage())('source.connectionRemoved'));
    const head = await access.provider.resolveHead(repoOf(source), source.branch, null);
    if (!head.changed) return { created: 0 };
    const read = await readSpec(access.provider, source, head.sha, application.slug);
    if (!read.ok) {
      await rejectCommit(source, head.sha, read.issues);
      return { created: 0 };
    }
    const bindings = await bindingsFor(source);
    if (bindings.length === 0) {
      // "Update from the repository": the head becomes the application's version,
      // without a deployment.
      await syncFromSource({
        source,
        sha: head.sha,
        spec: read.spec,
        trigger: 'manual',
        idle: source.deployTo === 'running',
        actorId: data.actorId,
        ip: data.ip,
      });
      await claimSourceCommit(source.id, source.lastSeenSha, head.sha, head.etag);
      await recordSourceCheck(source.id, { error: null });
      return { created: 0 };
    }
    const commit = await access.provider.commit(repoOf(source), head.sha);
    const result = await deployFromSource({
      source,
      sha: head.sha,
      spec: read.spec,
      commit,
      trigger: 'manual',
      bindings,
      actorId: data.actorId,
      ip: data.ip,
    });
    // The deployed head becomes polling's starting point.
    await claimSourceCommit(source.id, source.lastSeenSha, head.sha, head.etag);
    await recordSourceCheck(source.id, { error: skippedSummary(result) });
    return { created: result.created.length };
  } catch (error) {
    await recordSourceCheck(source.id, { error: errorMessage(error) });
    throw error;
  }
}
