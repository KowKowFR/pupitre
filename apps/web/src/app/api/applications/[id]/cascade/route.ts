import {
  APPLICATION_DELETE_JOB,
  applicationDeleteJobDataSchema,
  renderMessage,
  workspaceNameFor,
  type Permission,
} from '@pupitre/core';
import {
  countDeploymentsFor,
  getApplication,
  listApplicationDeletionBlockers,
  listApplicationPortAllocations,
  logAudit,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { applications as messages } from '@/i18n/messages/applications';
import { currentLanguage } from '@/i18n/server';
import { ConflictError, HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody, readSearchParams } from '@/lib/http';
import { getOpsQueue } from '@/lib/queue';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * An application's cascading deletion, and its emergency exit.
 *
 * A route separate from `DELETE /api/applications/:id`, which stays the simple
 * gesture: erasing an application that no longer holds anything. Here it is the
 * reverse — we assume it runs, and we are going to dismantle it on its targets
 * before erasing it. Two gestures, two paths, two sets of permissions.
 *
 * ── The required permissions ──────────────────────────────────────────────────
 * The operation does three things, so it requires the three corresponding
 * permissions: `deployment:destroy` (it dismantles on the machine),
 * `deployment:purge` (it erases the history) and `application:delete` (it deletes
 * the application). Their **union**, not one more permission: whoever can do all
 * three separately can chain them, and inventing a fourth word would have created
 * a power nobody has yet in any role.
 *
 * Forcing requires exactly the same ones, and no more — the RBAC vocabulary has
 * nothing stricter to offer. What it requires on top is not a permission but an
 * **intention**: the application's slug, typed again by hand, after seeing the
 * list of what is being abandoned. A checkbox is checked by reflex; a name is
 * copied while looking.
 */
const CASCADE_PERMISSIONS = [
  'deployment:destroy',
  'deployment:purge',
  'application:delete',
] as const satisfies readonly Permission[];

async function requireCascadePermissions(request: Request) {
  let auth = await requirePermission(request, CASCADE_PERMISSIONS[0]);
  for (const permission of CASCADE_PERMISSIONS.slice(1)) {
    auth = await requirePermission(request, permission);
  }
  return auth;
}

/**
 * What a forcing would abandon, **named**.
 *
 * The grouping's name comes from the shared convention (`workspaceNameFor`) and
 * not from a driver: `@pupitre/core/drivers` is outside the panel's graph. The
 * activity log, for its part, is written by the worker, which queries the driver
 * — that is where the authority is.
 */
function describe(
  blockers: Awaited<ReturnType<typeof listApplicationDeletionBlockers>>,
  slug: string,
) {
  return blockers.map((blocker) => ({
    deploymentId: blocker.id,
    version: blocker.version,
    status: blocker.status,
    runtime: blocker.runtime,
    reason: blocker.reason,
    message: blocker.message,
    targetId: blocker.targetId,
    targetName: blocker.targetName,
    targetHost: blocker.targetHost,
    workspace: workspaceNameFor(slug),
    publishedPort: blocker.publishedPort,
  }));
}

const querySchema = z.object({
  /**
   * Follows a cascade already started. On this route and not on
   * `/api/queue/jobs/:id`, which requires `job:read`: someone allowed to start a
   * deletion must be able to read its outcome without being granted the reading of
   * the whole queue. And the application may have disappeared in the meantime —
   * it is even the nominal case.
   */
  jobId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
});

/**
 * Preview. It writes nothing and serves the confirmation modal: it must **name**
 * — which target, which Compose project, which port —, not count. A count does
 * not allow anyone to go and finish the cleanup by hand.
 *
 * With `?jobId=`, it returns the state of a cascade in progress instead.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'application:delete');
  const { id } = paramsSchema.parse(await context.params);
  const { jobId } = readSearchParams(request, querySchema);

  if (jobId !== undefined) {
    const job = await getOpsQueue().getJob(jobId);
    if (!job) throw new NotFoundError(msg(messages, 'error.jobNotFound', { jobId }));

    // Another application's job has nothing to answer on this path.
    const data = applicationDeleteJobDataSchema.safeParse(job.data);
    if (!data.success || data.data.applicationId !== id) {
      throw new NotFoundError(msg(messages, 'error.jobOtherApplication', { jobId }));
    }

    return NextResponse.json({
      jobId: job.id,
      state: await job.getState(),
      finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
      result: job.returnvalue ?? null,
      failedReason: job.failedReason ?? null,
    });
  }

  const application = await getApplication(id);
  if (!application) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  const [blockers, reservedPorts, historyCount] = await Promise.all([
    listApplicationDeletionBlockers(id, { language: await currentLanguage() }),
    listApplicationPortAllocations(id),
    countDeploymentsFor(id),
  ]);

  const missing = CASCADE_PERMISSIONS.filter((permission) => !auth.can(permission));

  return NextResponse.json({
    applicationId: id,
    applicationSlug: application.slug,
    workspace: workspaceNameFor(application.slug),
    /** Empty ⇒ `DELETE /api/applications/:id` is enough, without cascade or forcing. */
    blockers: describe(blockers, application.slug),
    /** Deployments that will leave the history, `destroyed` included. */
    historyCount,
    reservedPorts,
    requiredPermissions: CASCADE_PERMISSIONS,
    missingPermissions: missing,
    canCascade: missing.length === 0,
  });
});

const cascadeSchema = z.object({
  /**
   * `false`: we destroy, and if a target resists we erase nothing.
   * `true`:  we still destroy first, and what resists is abandoned — named in the
   *          activity log, then erased from the database.
   */
  force: z.boolean().default(false),
  /** The application's slug, typed again. Required when forcing, ignored otherwise. */
  confirm: z.string().max(200).optional(),
});

export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requireCascadePermissions(request);
  const { id } = paramsSchema.parse(await context.params);
  const { force, confirm } = await readJsonBody(request, cascadeSchema);

  const application = await getApplication(id);
  if (!application) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  // The lists below go INTO the sentence: they cannot wait for serialization like
  // `msg()`. We read the language here so that the pieces agree.
  const language = await currentLanguage();
  const blockers = await listApplicationDeletionBlockers(id, { language });

  // A deployment in progress is neither destroyed nor erased, forcing included:
  // erasing the row under the worker writing it would leave the machine in a state
  // nobody could describe any more. It is transient — we wait.
  const inProgress = blockers.filter((blocker) => blocker.reason === 'in_progress');
  if (inProgress.length > 0) {
    throw new ConflictError(
      msg(messages, 'error.deploymentsInProgress', {
        count: inProgress.length,
        slug: application.slug,
        list: inProgress
          .map((blocker) =>
            renderMessage(messages, language, 'error.deploymentEntry', {
              version: blocker.version,
              target: blocker.targetName,
            }),
          )
          .join(', '),
      }),
    );
  }

  if (force && confirm !== application.slug) {
    throw new HttpError(
      422,
      'confirmation_required',
      msg(messages, 'error.confirmationRequired', {
        count: blockers.length,
        slug: application.slug,
        list: blockers
          .map((blocker) =>
            renderMessage(messages, language, 'error.abandonEntry', {
              workspace: workspaceNameFor(application.slug),
              target: blocker.targetName,
              host: blocker.targetHost,
              port:
                blocker.publishedPort === null
                  ? ''
                  : renderMessage(messages, language, 'error.abandonPort', {
                      port: blocker.publishedPort,
                    }),
            }),
          )
          .join(' ; '),
      }),
      { expected: application.slug, abandons: describe(blockers, application.slug) },
    );
  }

  const job = await getOpsQueue().add(
    APPLICATION_DELETE_JOB,
    applicationDeleteJobDataSchema.parse({
      applicationId: id,
      force,
      actorId: auth.userId,
      ip: auth.ip,
    }),
    // Never replayed: a replayed destruction makes no sense, and a replayed erasure
    // would concern an application that no longer exists.
    { attempts: 1 },
  );
  if (!job.id) throw new HttpError(500, 'enqueue_failed', msg(messages, 'error.enqueueFailed'));

  // Traced **before** anything disappears: if the worker collapses midway, the log
  // at least says what had been asked, and on what.
  await logAudit({
    actorId: auth.userId,
    action: force ? 'application.delete.force.requested' : 'application.delete.requested',
    resourceType: 'application',
    resourceId: id,
    before: { slug: application.slug },
    after: {
      jobId: job.id,
      forced: force,
      blockers: describe(blockers, application.slug),
    },
    ip: auth.ip,
  });

  return NextResponse.json(
    {
      id,
      jobId: job.id,
      state: 'queued',
      forced: force,
      blockers: describe(blockers, application.slug),
    },
    { status: 202 },
  );
});
