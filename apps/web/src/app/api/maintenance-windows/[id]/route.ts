import { createMaintenanceSchema, maintenancePhase, updateMaintenanceSchema } from '@pupitre/core';
import {
  deleteMaintenanceWindow,
  getMaintenanceWindow,
  logAudit,
  updateMaintenanceWindow,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { maintenance as messages } from '@/i18n/messages/maintenance';
import { ConflictError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { assertSubjects, heldAlertsJson, maintenanceJson } from '@/lib/maintenance';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

async function load(id: string) {
  const window = await getMaintenanceWindow(id);
  if (!window) throw new NotFoundError(msg(messages, 'error.notFound'));
  return window;
}

/** Une fenêtre, avec les alertes qu'elle a retenues. */
export const GET = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'maintenance:read');
  const { id } = paramsSchema.parse(await context.params);
  const window = await load(id);
  return NextResponse.json({
    ...maintenanceJson(window, auth),
    heldAlerts: await heldAlertsJson(id),
  });
});

/**
 * Modifier une fenêtre — et la terminer : `{ "endsAt": maintenant }`. Une
 * fenêtre terminée ne se modifie plus : sa fin a été traitée, ce qui devait
 * partir est parti, et la rouvrir retiendrait des alertes que personne ne
 * libérerait.
 */
export const PATCH = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'maintenance:manage');
  const { id } = paramsSchema.parse(await context.params);
  const patch = await readJsonBody(request, updateMaintenanceSchema);
  const current = await load(id);
  if (current.endedAt !== null || maintenancePhase(current) === 'ended') {
    throw new ConflictError(msg(messages, 'error.ended'));
  }

  // Les règles s'appliquent à la fenêtre qui en résulte, pas au seul correctif.
  const merged = createMaintenanceSchema.parse({
    title: patch.title ?? current.title,
    note: patch.note !== undefined ? patch.note : current.note,
    startsAt: patch.startsAt ?? current.startsAt.toISOString(),
    endsAt: patch.endsAt ?? current.endsAt.toISOString(),
    targetIds: patch.targetIds ?? current.targets.map((target) => target.id),
    monitorIds: patch.monitorIds ?? current.monitors.map((monitor) => monitor.id),
  });
  const names = await assertSubjects(auth, {
    targetIds: patch.targetIds ?? [],
    monitorIds: patch.monitorIds ?? [],
  });

  const updated = await updateMaintenanceWindow(id, patch);
  if (!updated) throw new NotFoundError(msg(messages, 'error.notFound'));
  await logAudit({
    actorId: auth.userId,
    action: 'maintenance.updated',
    resourceType: 'maintenance_window',
    resourceId: id,
    before: {
      title: current.title,
      startsAt: current.startsAt.toISOString(),
      endsAt: current.endsAt.toISOString(),
      targets: current.targets.map((target) => target.name),
      monitors: current.monitors.map((monitor) => monitor.name),
    },
    after: {
      title: merged.title,
      startsAt: merged.startsAt,
      endsAt: merged.endsAt,
      targets: patch.targetIds ? names.targets : current.targets.map((target) => target.name),
      monitors: patch.monitorIds ? names.monitors : current.monitors.map((monitor) => monitor.name),
    },
    ip: auth.ip,
  });
  return NextResponse.json(maintenanceJson(updated, auth));
});

/**
 * Supprimer une fenêtre à venir, ou l'historique d'une fenêtre terminée. Une
 * fenêtre **en cours** ne se supprime pas : ses alertes retenues disparaîtraient
 * avec elle. On la termine (`PATCH endsAt`), et sa fin libère ce qui doit partir.
 */
export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'maintenance:manage');
  const { id } = paramsSchema.parse(await context.params);
  const current = await load(id);
  const phase = maintenancePhase(current);
  if (phase === 'active' || (phase === 'ended' && current.endedAt === null)) {
    throw new ConflictError(msg(messages, 'error.active'));
  }
  await deleteMaintenanceWindow(id);
  await logAudit({
    actorId: auth.userId,
    action: 'maintenance.deleted',
    resourceType: 'maintenance_window',
    resourceId: id,
    before: {
      title: current.title,
      startsAt: current.startsAt.toISOString(),
      endsAt: current.endsAt.toISOString(),
      targets: current.targets.map((target) => target.name),
      monitors: current.monitors.map((monitor) => monitor.name),
      held: current.held,
    },
    ip: auth.ip,
  });
  return new NextResponse(null, { status: 204 });
});
