import { MONITOR_CHECK_RETENTION_DAYS, isMonitorType } from '@tp/core';
import {
  MonitorConfigError,
  deleteMonitor,
  getApplication,
  getMonitor,
  listChecks,
  listIncidents,
  logAudit,
  monitorTarget,
  updateMonitor,
  updateMonitorSchema,
} from '@tp/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { HttpError, NotFoundError } from '@/lib/errors';
import { apiRoute, readJsonBody, readSearchParams } from '@/lib/http';
import {
  assertConfigAllowed,
  assertUrlAllowed,
  buildMonitorViews,
  toCheckView,
  toIncidentView,
} from '@/lib/monitors';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

const querySchema = z.object({
  checks: z.coerce.number().int().min(1).max(1000).default(200),
  incidents: z.coerce.number().int().min(1).max(200).default(50),
});

function translate(error: unknown): never {
  if (error instanceof MonitorConfigError) {
    throw new HttpError(422, 'validation_failed', error.message, { field: error.field });
  }
  throw error;
}

export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'monitor:read');
  const { id } = paramsSchema.parse(await context.params);
  const { checks, incidents } = readSearchParams(request, querySchema);

  const row = await getMonitor(id);
  if (!row) throw new NotFoundError(`Sonde « ${id} » introuvable`);

  const [[item], checkRows, incidentRows] = await Promise.all([
    buildMonitorViews([row]),
    listChecks(id, checks),
    listIncidents(id, incidents),
  ]);

  return NextResponse.json({
    ...item,
    // De la plus ancienne à la plus récente : c'est le sens d'une courbe.
    checks: checkRows.slice().reverse().map(toCheckView),
    incidents: incidentRows.map(toIncidentView),
    retentionDays: MONITOR_CHECK_RETENTION_DAYS,
  });
});

export const PATCH = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'monitor:manage');
  const { id } = paramsSchema.parse(await context.params);
  const patch = await readJsonBody(request, updateMonitorSchema);

  const before = await getMonitor(id);
  if (!before) throw new NotFoundError(`Sonde « ${id} » introuvable`);

  // Le type ne se modifie pas : changer le type d'une sonde, c'est en créer une
  // autre — son historique et ses incidents porteraient sur autre chose.
  if (patch.config !== undefined && isMonitorType(before.type)) {
    await assertConfigAllowed(before.type, patch.config);
  }
  if (patch.webhookUrl) await assertUrlAllowed(patch.webhookUrl, 'webhookUrl');

  if (patch.applicationId !== undefined && patch.applicationId !== null) {
    const application = await getApplication(patch.applicationId);
    if (!application) {
      throw new NotFoundError(`Application « ${patch.applicationId} » introuvable`);
    }
  }

  const after = await updateMonitor(id, patch).catch(translate);
  if (!after) throw new NotFoundError(`Sonde « ${id} » introuvable`);

  await logAudit({
    actorId: auth.userId,
    action: 'monitor.updated',
    resourceType: 'monitor',
    resourceId: id,
    before: {
      name: before.name,
      target: monitorTarget(before),
      enabled: before.enabled,
      intervalSeconds: before.intervalSeconds,
      failureThreshold: before.failureThreshold,
      recoveryThreshold: before.recoveryThreshold,
      hasWebhook: before.webhookUrlEncrypted !== null,
    },
    after: {
      name: after.name,
      target: monitorTarget(after),
      enabled: after.enabled,
      intervalSeconds: after.intervalSeconds,
      failureThreshold: after.failureThreshold,
      recoveryThreshold: after.recoveryThreshold,
      hasWebhook: after.webhookUrlEncrypted !== null,
    },
    ip: auth.ip,
  });

  const [item] = await buildMonitorViews([after]);
  return NextResponse.json(item);
});

export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'monitor:manage');
  const { id } = paramsSchema.parse(await context.params);

  const row = await getMonitor(id);
  if (!row) throw new NotFoundError(`Sonde « ${id} » introuvable`);

  // Les mesures et les incidents partent avec, par cascade : une sonde
  // supprimée n'a pas d'historique à conserver — c'est son historique.
  const removed = await deleteMonitor(id);
  if (!removed) throw new NotFoundError(`Sonde « ${id} » introuvable`);

  await logAudit({
    actorId: auth.userId,
    action: 'monitor.deleted',
    resourceType: 'monitor',
    resourceId: id,
    before: { name: row.name, type: row.type, target: monitorTarget(row), status: row.status },
    ip: auth.ip,
  });

  return NextResponse.json({ id, deleted: true });
});
