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
import { currentLanguage } from '@/i18n/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

const querySchema = z.object({
  checks: z.coerce.number().int().min(1).max(1000).default(200),
  incidents: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * `resolveConfig()`'s refusal arrives as data; the sentence is made in
 * `lib/monitors`, where the instance's language is readable. Both probe routes go
 * through there, so they say the same thing.
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
    // From the oldest to the most recent: it is a curve's direction.
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

  // The type cannot be changed: changing a probe's type is creating another one —
  // its history and its incidents would be about something else.
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
      target: monitorTarget(before, await currentLanguage()),
      enabled: before.enabled,
      intervalSeconds: before.intervalSeconds,
      failureThreshold: before.failureThreshold,
      recoveryThreshold: before.recoveryThreshold,
      hasWebhook: before.webhookUrlEncrypted !== null,
    },
    after: {
      name: after.name,
      target: monitorTarget(after, await currentLanguage()),
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

  // The measurements and incidents go with it, through cascade: a deleted probe has
  // no history to keep — it is its history.
  const removed = await deleteMonitor(id);
  if (!removed) throw new NotFoundError(msg(messages, 'error.monitorNotFound', { id }));

  await logAudit({
    actorId: auth.userId,
    action: 'monitor.deleted',
    resourceType: 'monitor',
    resourceId: id,
    before: {
      name: row.name,
      type: row.type,
      target: monitorTarget(row, await currentLanguage()),
      status: row.status,
    },
    ip: auth.ip,
  });

  return NextResponse.json({ id, deleted: true });
});
