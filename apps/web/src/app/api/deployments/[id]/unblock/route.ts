import { renderMessage } from '@pupitre/core';
import { abandonDeployment, getDeploymentSummary, logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deployments as messages } from '@/i18n/messages/deployments';
import { currentLanguage } from '@/i18n/server';
import { ConflictError, HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { logger } from '@/lib/logger';
import { getOpsQueue } from '@/lib/queue';
import { requirePermission } from '@/lib/rbac';
import { inspectDeployment, refusalMessage } from '@/lib/stuck-deployments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * Unblocks a stuck deployment: the "in progress" status becomes "failed".
 *
 * ── Why `deployment:purge` ───────────────────────────────────────────────────
 * The gesture does not touch the machine — it fixes a record the panel left
 * lying. It is exactly the split the RBAC vocabulary sets: "Destroying removes
 * the application from the machine; purging erases the trace in the database. Two
 * different gestures, two permissions." Unblocking is on the database's side. And
 * it is literally the act that lifts a purge refusal: the purge refuses an
 * `in_progress` deployment, and nothing else could take it out of that state.
 * Requiring `deployment:destroy` would have suggested something was going to be
 * dismantled; nothing is dismantled, we stop lying.
 *
 * ── Why no resumption ────────────────────────────────────────────────────────
 * Nothing is queued again. Replaying a pipeline without knowing where it stopped
 * would redeploy on top of an unknown state. The deployment is stopped on a
 * failure that **names what remains to check on the target**; it is then the
 * destruction — an explicit gesture, with its own permission — that wipes the
 * machine clean.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'deployment:purge');
  const { id } = paramsSchema.parse(await context.params);

  const summary = await getDeploymentSummary(id);
  if (!summary) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  if (summary.status !== 'pending' && summary.status !== 'running') {
    throw new ConflictError(msg(messages, 'error.alreadySettled', { status: summary.status }));
  }

  const verdict = await inspectDeployment(getOpsQueue(), id);
  // Concluded between the two reads: the worker gave its verdict on its own.
  if (!verdict) {
    throw new ConflictError(msg(messages, 'error.settledWhileChecking'));
  }

  if (!verdict.ghost) {
    throw new HttpError(409, 'deployment_not_stuck', refusalMessage(verdict), {
      job: verdict.job,
      ageSeconds: Math.round(verdict.ageMs / 1000),
    });
  }

  // The verdict is written once into the deployment's error and stays there, like
  // the deployment's log: in the instance's language that day.
  const language = await currentLanguage();
  const report = await abandonDeployment(id, {
    cause: renderMessage(messages, language, 'unblock.cause'),
    language,
  });
  if (!report) {
    throw new ConflictError(msg(messages, 'error.settledWhileUnblocking'));
  }

  await logAudit({
    actorId: auth.userId,
    action: 'deployment.unblocked',
    resourceType: 'deployment',
    resourceId: id,
    before: { status: summary.status, failedStep: summary.failedStep },
    after: {
      status: 'failed',
      failedStep: report.failedStep,
      mayHaveStartedServices: report.mayHaveStartedServices,
      applicationSlug: report.applicationSlug,
      targetName: report.targetName,
      error: report.error,
      // i18n-ignore — activity log payload, not interface: it is read back by a human
      // investigating, months later, and the log is in the project's language like
      // the action names.
      detectedBy: 'no runnable job in the "ops" queue',
    },
    ip: auth.ip,
  });

  logger.warn(
    { deploymentId: id, failedStep: report.failedStep },
    'stuck deployment unblocked by hand',
  );

  return NextResponse.json({
    id,
    status: 'failed' as const,
    failedStep: report.failedStep,
    mayHaveStartedServices: report.mayHaveStartedServices,
    error: report.error,
  });
});
