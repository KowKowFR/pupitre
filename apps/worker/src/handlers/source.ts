import {
  classifySpecChange,
  defaultWatchPaths,
  parseAppSpec,
  parseSourceSpec,
  sourceDeployJobDataSchema,
  sourcePollJobDataSchema,
  touchesWatchPaths,
  type AppSpec,
  type SourceProvider,
  type RepositoryRef,
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
import { logger } from '../logger.js';
import { deployFromSource, skippedSummary } from '../sources/deploy.js';
import { getSourceProvider } from '../sources/provider.js';
import { panelUrl, reportCommitStatus, statusLanguage, statusText } from '../sources/status.js';

/**
 * Les dépôts liés, côté worker.
 *
 * `source:poll` pose chaque minute la même question à chaque liaison active :
 * « le dernier commit de la branche a-t-il changé ? ». La réponse coûte un
 * appel HTTP, et presque rien quand elle est « non » (ETag → 304). Quand elle
 * est « oui », dans l'ordre :
 *
 *   1. le commit concerne-t-il l'application ? (chemins surveillés, monorepo)
 *   2. son `pupitre.json` est-il valable ?
 *   3. le commit est **réservé** — une écriture conditionnelle en base : deux
 *      passages qui se chevauchent ne déploient pas deux fois ;
 *   4. selon le mode de la liaison, il part, ou il attend une validation.
 *
 * La toute première vérification d'une liaison ne déploie rien : elle note le
 * commit en tête. Lier un dépôt ne doit pas redéployer ce qui tourne déjà —
 * « Déployer ce commit » est là pour ça.
 */

function repoOf(source: ApplicationSourceView): RepositoryRef {
  return { fullName: source.repository, installationId: source.installationId };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ReadSpec =
  | { ok: true; spec: AppSpec }
  | { ok: false; issues: string[] };

/** Le `pupitre.json` du commit, validé, au nom de l'application liée. */
async function readSpec(
  provider: SourceProvider,
  source: ApplicationSourceView,
  sha: string,
  applicationSlug: string,
): Promise<ReadSpec> {
  const content = await provider.readFile(repoOf(source), sha, source.specPath);
  if (content === null) return { ok: false, issues: [`${source.specPath} absent à ce commit`] };
  return parseSourceSpec(content, applicationSlug);
}

/** Un `pupitre.json` refusé : écrit sur la liaison, au journal, et sur le commit. */
async function rejectCommit(
  source: ApplicationSourceView,
  sha: string,
  issues: string[],
): Promise<void> {
  const error = `${source.specPath} refusé au commit ${sha.slice(0, 7)} : ${issues.join(' ; ')}`;
  await recordSourceCheck(source.id, { error });
  await logAudit({
    action: 'source.commit.rejected',
    resourceType: 'application_source',
    resourceId: source.id,
    after: { repository: source.repository, branch: source.branch, sha, issues },
  });
  const language = await statusLanguage();
  const base = panelUrl();
  await reportCommitStatus(repoOf(source), sha, {
    state: 'error',
    description: statusText(language, 'invalid', { issue: issues[0] ?? '' }),
    context: 'pupitre',
    targetUrl: base ? `${base}/applications/${source.applicationId}` : null,
  });
}

/** Un commit neuf et pertinent : il part, ou il attend un humain. */
async function takeCommit(
  provider: SourceProvider,
  source: ApplicationSourceView,
  sha: string,
  spec: AppSpec,
  current: AppSpec | null,
): Promise<'deployed' | 'proposed'> {
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
    await reportCommitStatus(repoOf(source), sha, {
      state: 'pending',
      description: statusText(language, 'proposal'),
      context: 'pupitre',
      targetUrl: base ? `${base}/applications/${source.applicationId}` : null,
    });
    return 'proposed';
  }

  const result = await deployFromSource({
    source,
    sha,
    spec,
    commit,
    trigger: 'auto',
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
    // GitHub a répondu : une erreur de connexion d'avant est levée. Un
    // pupitre.json refusé, lui, le reste tant que la tête n'a pas changé.
    const rejected = source.lastError?.startsWith(`${source.specPath} refusé`) ?? false;
    await recordSourceCheck(source.id, {
      ...(head.changed ? { etag: head.etag } : {}),
      error: rejected ? source.lastError : null,
    });
    return 'unchanged';
  }

  // Première vérification : on note la tête, on ne déploie rien.
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

  // Réservé avant d'agir : si un autre passage l'a déjà pris, on s'arrête là.
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

/** `source:poll` — toutes les liaisons actives, ou une seule (« Vérifier maintenant »). */
export async function handleSourcePoll(job: Job): Promise<{ checked: number }> {
  const data = sourcePollJobDataSchema.parse(job.data);
  const access = await getSourceProvider();
  if (!access) return { checked: 0 };

  const sources = data.sourceId
    ? [await getApplicationSource(data.sourceId)].filter(
        (source): source is ApplicationSourceView => source !== null,
      )
    : await listEnabledSources();

  let checked = 0;
  for (const source of sources) {
    const log = logger.child({ sourceId: source.id, repository: source.repository });
    try {
      const outcome = await pollSource(access.provider, source, data.force);
      if (outcome !== 'unchanged') log.info({ outcome }, 'dépôt lié vérifié');
    } catch (error) {
      // Une liaison en panne n'arrête pas les autres : l'erreur est écrite sur
      // elle, en clair, et la minute suivante réessaie.
      log.warn({ err: error }, 'vérification du dépôt impossible');
      await recordSourceCheck(source.id, { error: messageOf(error) });
    }
    checked += 1;
  }
  return { checked };
}

/**
 * `source:deploy` — un humain a décidé : déployer la tête de la branche, ou
 * un commit en attente qu'il vient de valider.
 */
export async function handleSourceDeploy(job: Job): Promise<{ created: number }> {
  const data = sourceDeployJobDataSchema.parse(job.data);
  const access = await getSourceProvider();
  if (!access) throw new Error('aucune GitHub App connectée');

  if (data.kind === 'proposal') {
    const proposal = await getSourceProposal(data.proposalId);
    if (!proposal || proposal.status !== 'approved') return { created: 0 };
    const source = await getApplicationSource(proposal.sourceId);
    if (!source) return { created: 0 };
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
    const head = await access.provider.resolveHead(repoOf(source), source.branch, null);
    if (!head.changed) return { created: 0 };
    const read = await readSpec(access.provider, source, head.sha, application.slug);
    if (!read.ok) {
      await rejectCommit(source, head.sha, read.issues);
      return { created: 0 };
    }
    const commit = await access.provider.commit(repoOf(source), head.sha);
    const result = await deployFromSource({
      source,
      sha: head.sha,
      spec: read.spec,
      commit,
      trigger: 'manual',
      actorId: data.actorId,
      ip: data.ip,
    });
    // La tête déployée devient le point de départ du polling.
    await claimSourceCommit(source.id, source.lastSeenSha, head.sha, head.etag);
    await recordSourceCheck(source.id, { error: skippedSummary(result) });
    return { created: result.created.length };
  } catch (error) {
    await recordSourceCheck(source.id, { error: messageOf(error) });
    throw error;
  }
}
