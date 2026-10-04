import {
  APP_START_JOB,
  APP_STOP_JOB,
  deploymentJobDataSchema,
  isSupervisable,
} from '@pupitre/core';
import { getDeploymentSummary, logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { appConsole } from '@/i18n/messages/console';
import { deployments } from '@/i18n/messages/deployments';
import { ConflictError, HttpError, NotFoundError, msg, type MessageRef } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { getSupervisionQueue } from '@/lib/supervision-queue';

/**
 * Stopping and starting again, panel side.
 *
 * The two routes are the same gesture but for the sign: same permission, same
 * refusals, same queue, same response shape. This module carries what they have
 * in common, and each route boils down to the line that sets it apart — that is
 * also what guarantees that a refusal added tomorrow will hold for both.
 *
 * Nothing else is done here: the route queues and returns the job identifier.
 * The work — SSH session, driver, database write — belongs to the worker.
 *
 * ── The permission, and why it is not a new one ─────────────────────────────
 * `deployment:restart`. A restart *is* a stop followed by a start: the same
 * service interruption, the same absence of consequence on the data and the
 * version. A distinct `deployment:stop` permission would have produced a role
 * able to cut the service through the next button but not through this one — a
 * boundary nobody could explain, and a trap for whoever composes a role.
 */

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

type Gesture = {
  /** `stop` stops, `start` starts again. */
  key: 'stop' | 'start';
  jobName: typeof APP_STOP_JOB | typeof APP_START_JOB;
  auditAction: string;
  /**
   * Refusal when the application is already in the targeted state. Returning 202
   * on a gesture without effect would suggest an action; we prefer to say so.
   */
  refuseWhen: (stoppedAt: Date | null) => MessageRef | null;
};

export const STOP_GESTURE: Gesture = {
  key: 'stop',
  jobName: APP_STOP_JOB,
  auditAction: 'app.stop.requested',
  refuseWhen: (stoppedAt) =>
    stoppedAt === null
      ? null
      : // A neutral timestamp: the sentence is rendered in the requester's language, not
        // the date — it reads in UTC, like the activity log.
        msg(appConsole, 'error.alreadyStopped', {
          date: `${stoppedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
        }),
};

export const START_GESTURE: Gesture = {
  key: 'start',
  jobName: APP_START_JOB,
  auditAction: 'app.start.requested',
  refuseWhen: (stoppedAt) => (stoppedAt === null ? msg(appConsole, 'error.notStopped') : null),
};

export function lifecycleRoute(gesture: Gesture) {
  return apiRoute<Context>(async (request, context) => {
    const auth = await requirePermission(request, 'deployment:restart');
    const { id } = paramsSchema.parse(await context.params);

    const deployment = await getDeploymentSummary(id);
    if (!deployment) throw new NotFoundError(msg(deployments, 'error.notFound', { id }));

    // The same guard as the restart and the log stream: outside these two statuses,
    // there is no running application one can act on.
    if (!isSupervisable(deployment.status)) {
      throw new ConflictError(
        msg(appConsole, `error.notSupervisable.${gesture.key}`, { status: deployment.status }),
      );
    }

    const refusal = gesture.refuseWhen(deployment.stoppedAt);
    if (refusal) throw new ConflictError(refusal);

    const job = await getSupervisionQueue().add(
      gesture.jobName,
      deploymentJobDataSchema.parse({ deploymentId: id, actorId: auth.userId, ip: auth.ip }),
    );
    if (!job.id) {
      throw new HttpError(500, 'enqueue_failed', msg(deployments, 'error.enqueueFailed'));
    }

    await logAudit({
      actorId: auth.userId,
      action: gesture.auditAction,
      resourceType: 'deployment',
      resourceId: id,
      after: {
        jobId: job.id,
        applicationSlug: deployment.applicationSlug,
        targetName: deployment.targetName,
      },
      ip: auth.ip,
    });

    return NextResponse.json({ id, jobId: job.id, state: 'queued' }, { status: 202 });
  });
}
