import { isSupervisable, workspaceNameFor } from '@pupitre/core';
import { getDeploymentSummary } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { deployments } from '@/i18n/messages/deployments';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * What one needs to know to offer — or refuse — an application's operating
 * gestures: is it stopped, since when, is there a previous version, which port
 * and which grouping a destruction would take away.
 *
 * ── Why a route, when the page could pass everything as props ───────────────
 * Because the gestures change the state they show. After a stop, the button must
 * become "Start" without reloading the page, and the reverse after a start. A
 * prop rendered on the server side only moves on `router.refresh()`, which
 * replays the whole page — including the log console and its SSE reconnection. A
 * read of a few fields is better.
 *
 * It does **not** touch the machine: everything comes from the database. Opening
 * an SSH session in an HTTP route is precisely what the project forbids, and the
 * containers' real state already arrives through the monitoring stream.
 *
 * `deployment:read` is enough: it says nothing more than the page itself.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'deployment:read');
  const { id } = paramsSchema.parse(await context.params);

  const deployment = await getDeploymentSummary(id);
  if (!deployment) throw new NotFoundError(msg(deployments, 'error.notFound', { id }));

  // The version a rollback brings back to, named: "go back to v2" is understood,
  // "go back" is endured.
  const previous = deployment.previousDeploymentId
    ? await getDeploymentSummary(deployment.previousDeploymentId)
    : null;

  return NextResponse.json({
    id: deployment.id,
    status: deployment.status,
    supervisable: isSupervisable(deployment.status),
    stoppedAt: deployment.stoppedAt?.toISOString() ?? null,
    number: deployment.number,
    version: deployment.version,
    url: deployment.url,
    publishedPort: deployment.publishedPort,
    applicationId: deployment.applicationId,
    applicationSlug: deployment.applicationSlug,
    targetId: deployment.targetId,
    targetName: deployment.targetName,
    runtime: deployment.runtime,
    workspace: workspaceNameFor(deployment.applicationSlug),
    previous: previous
      ? { id: previous.id, number: previous.number, version: previous.version }
      : null,
  });
});
