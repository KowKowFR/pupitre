import {
  applicationSourcePatchSchema,
  deleteApplicationSource,
  logAudit,
  sourceTargetsProblem,
  updateApplicationSource,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sources as messages } from '@/i18n/messages/sources';
import { HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { assertTargets, sourceJson, sourceOf } from '@/lib/source-routes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid(), sourceId: z.string().uuid() });
type Context = { params: Promise<{ id: string; sourceId: string }> };

/** Branche, fichier de spec, chemins surveillés, cibles, mode, pause. Jamais le dépôt. */
export const PATCH = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'application:update');
  const { id, sourceId } = paramsSchema.parse(await context.params);
  const patch = await readJsonBody(request, applicationSourcePatchSchema);
  const before = await sourceOf(id, sourceId);
  if (patch.targets) await assertTargets(patch.targets);
  // La règle porte sur l'état d'arrivée : passer en « cibles de la liaison »
  // sans en donner, ou retirer les dernières, est refusé.
  const problem = sourceTargetsProblem(
    patch.deployTo ?? before.deployTo,
    patch.targets ?? before.targets,
  );
  if (problem) throw new HttpError(422, 'source_targets', msg(messages, 'error.targetsRequired'));

  const after = await updateApplicationSource(sourceId, patch);
  if (!after) throw new NotFoundError(msg(messages, 'error.sourceNotFound', { id: sourceId }));

  const shape = (source: typeof before) => ({
    branch: source.branch,
    specPath: source.specPath,
    watchPaths: source.watchPaths,
    mode: source.mode,
    deployTo: source.deployTo,
    enabled: source.enabled,
    targets: source.targets.map((target) => `${target.targetName}:${target.runtime}`),
  });
  await logAudit({
    actorId: auth.userId,
    action: 'source.updated',
    resourceType: 'application_source',
    resourceId: sourceId,
    before: { repository: before.repository, ...shape(before) },
    after: { repository: after.repository, ...shape(after) },
    ip: auth.ip,
  });
  return NextResponse.json(sourceJson(after));
});

/** Délier : Pupitre cesse de suivre la branche. Rien n'est détruit sur les cibles. */
export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'application:update');
  const { id, sourceId } = paramsSchema.parse(await context.params);
  const source = await sourceOf(id, sourceId);
  await deleteApplicationSource(sourceId);
  await logAudit({
    actorId: auth.userId,
    action: 'source.unlinked',
    resourceType: 'application_source',
    resourceId: sourceId,
    before: { repository: source.repository, branch: source.branch, mode: source.mode },
    ip: auth.ip,
  });
  return NextResponse.json({ ok: true });
});
