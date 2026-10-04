import {
  MONITOR_CHECK_RETENTION_DAYS,
  MONITOR_FAILURE_THRESHOLD_DEFAULT,
  MONITOR_RECOVERY_THRESHOLD_DEFAULT,
  MONITOR_TYPES_LIST,
} from '@pupitre/core';
import {
  MonitorConfigError,
  createMonitor,
  createMonitorSchema,
  getApplication,
  listAdoptableApps,
  listMonitors,
  logAudit,
  monitorTarget,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { monitors as messages } from '@/i18n/messages/monitors';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import {
  assertConfigAllowed,
  assertUrlAllowed,
  buildMonitorViews,
  monitorConfigMessage,
  monitorTypeOptions,
} from '@/lib/monitors';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Monitoring probes.
 *
 * ── The link with deployments ────────────────────────────────────────────────
 * The panel already knows the URL of everything it deploys. It **still does not
 * create the probe on its own**, and that is a choice:
 *
 *   - Creating automatically means being able to cancel. Yet an auto-created
 *     probe the operator deletes would reappear at the next deployment, unless a
 *     table of tombstones is kept — a third object, for a convenience.
 *   - A probe emits outgoing traffic from the worker, every minute, toward a
 *     target. It is not a side effect a `POST /api/deployments` should produce
 *     without being asked.
 *   - The deployment gesture lives in `apps/worker/src/deploy/`, outside this
 *     work's scope: plugging it there would have been building on occupied
 *     ground.
 *
 * Instead: `GET` returns `adoptable`, the list of deployed applications,
 * reachable and not monitored yet. The screen turns it into a "Monitor" button
 * that prefills everything. One click, and the operator knows what they created.
 *
 * In the other direction, the link is automatic: the probe of a destroyed
 * application is **paused** by the sweep, with its reason, rather than crying
 * outage. It is resumed with a click.
 */

/**
 * `resolveConfig()`'s refusal arrives as data; the sentence is made in
 * `lib/monitors`, where the instance's language is readable. Both probe routes go
 * through there, so they say the same thing.
 */
async function translate(error: unknown): Promise<never> {
  if (error instanceof MonitorConfigError) throw await monitorConfigMessage(error);
  throw error;
}

export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'monitor:read');

  const [rows, adoptable] = await Promise.all([listMonitors(), listAdoptableApps()]);
  const items = await buildMonitorViews(rows);

  return NextResponse.json({
    items,
    total: items.length,
    adoptable,
    // The catalog is **sent to the client**: it is what tells the screen which fields
    // to show for each type. Without it there would have to be one `if` per type in
    // the form, and adding a type would become surgery.
    types: await monitorTypeOptions(MONITOR_TYPES_LIST),
    defaults: {
      failureThreshold: MONITOR_FAILURE_THRESHOLD_DEFAULT,
      recoveryThreshold: MONITOR_RECOVERY_THRESHOLD_DEFAULT,
    },
    retentionDays: MONITOR_CHECK_RETENTION_DAYS,
  });
});

export const POST = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'monitor:manage');
  const input = await readJsonBody(request, createMonitorSchema);

  // The SSRF guard, at creation. The worker does it again at each hop: a guard that
  // only holds here would not be one.
  await assertConfigAllowed(input.type, input.config);
  if (input.webhookUrl) await assertUrlAllowed(input.webhookUrl, 'webhookUrl');

  if (input.applicationId !== null) {
    const application = await getApplication(input.applicationId);
    if (!application) {
      throw new NotFoundError(
        msg(messages, 'error.applicationNotFound', { id: input.applicationId }),
      );
    }
  }

  const row = await createMonitor(input, auth.userId).catch(translate);

  await logAudit({
    actorId: auth.userId,
    action: 'monitor.created',
    resourceType: 'monitor',
    resourceId: row.id,
    after: {
      name: row.name,
      type: row.type,
      target: monitorTarget(row),
      intervalSeconds: row.intervalSeconds,
      failureThreshold: row.failureThreshold,
      recoveryThreshold: row.recoveryThreshold,
      applicationId: row.applicationId,
      // Never the webhook's URL: it is a secret, and an audit log gets read.
      hasWebhook: row.webhookUrlEncrypted !== null,
    },
    ip: auth.ip,
  });

  const [item] = await buildMonitorViews([row]);
  return NextResponse.json(item, { status: 201 });
});
