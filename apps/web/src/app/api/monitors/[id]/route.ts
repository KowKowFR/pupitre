import { MONITOR_CHECK_RETENTION_DAYS, isMonitorType } from '@pupitre/core';
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
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { monitors as messages } from '@/i18n/messages/monitors';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody, readSearchParams } from '@/lib/http';
import {
  assertConfigAllowed,
  assertUrlAllowed,
  buildMonitorViews,
  monitorConfigMessage,
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

/**
 * Le refus de `resolveConfig()` arrive en donnée ; la phrase se fabrique dans
 * `lib/monitors`, où la langue de l'instance est lisible. Les deux routes de
 * sonde passent par là, donc disent la même chose.
 */
async function translate(error: unknown): Promise<never> {
  if (error instanceof MonitorConfigError) throw await monitorConfigMessage(error);
  throw error;
}

export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'monitor:read');
  const { id } = paramsSchema.parse(await context.params);
  const { checks, incidents } = readSearchParams(request, querySchema);

  const row = await getMonitor(id);
  if (!row) throw new NotFoundError(msg(messages, 'error.monitorNotFound', { id }));

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
  if (!before) throw new NotFoundError(msg(messages, 'error.monitorNotFound', { id }));

  // Le type ne se modifie pas : changer le type d'une sonde, c'est en créer une
  // autre — son historique et ses incidents porteraient sur autre chose.
  if (patch.config !== undefined && isMonitorType(before.type)) {
    await assertConfigAllowed(before.type, patch.config);
  }
  if (patch.webhookUrl) await assertUrlAllowed(patch.webhookUrl, 'webhookUrl');

  if (patch.applicationId !== undefined && patch.applicationId !== null) {
    const application = await getApplication(patch.applicationId);
    if (!application) {
      throw new NotFoundError(
        msg(messages, 'error.applicationNotFound', { id: patch.applicationId }),
      );
    }
  }

  const after = await updateMonitor(id, patch).catch(translate);
  if (!after) throw new NotFoundError(msg(messages, 'error.monitorNotFound', { id }));

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
  if (!row) throw new NotFoundError(msg(messages, 'error.monitorNotFound', { id }));

  // Les mesures et les incidents partent avec, par cascade : une sonde
  // supprimée n'a pas d'historique à conserver — c'est son historique.
  const removed = await deleteMonitor(id);
  if (!removed) throw new NotFoundError(msg(messages, 'error.monitorNotFound', { id }));

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
