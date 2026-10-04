import {
  HOST_METRIC_LIST,
  deleteThreshold,
  getTarget,
  hostMetricKeySchema,
  listThresholdRows,
  logAudit,
  upsertThreshold,
  upsertThresholdSchema,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { settings } from '@/i18n/messages/settings';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody, readSearchParams } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { currentLanguage } from '@/i18n/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The server monitoring's thresholds.
 *
 * ── Why a route and not only a constant ─────────────────────────────────────
 * "A threshold that cannot be set is a threshold that gets turned off." A build
 * server lives at 95% disk by design; without a setting, the operator learns in
 * a week to ignore the alerts — and will ignore the real one too.
 *
 * ── Why three layers ────────────────────────────────────────────────────────
 *   catalog → always present, so a new instance alerts without any setting
 *   global  → `targetId: null`, the house behavior
 *   machine → the exception, where it is justified
 * The resolution is done in the database (`resolveThresholds`), never copied here.
 *
 * ── Why `target:update` and not `settings:manage` ───────────────────────────
 * Setting from when a machine is struggling is describing that machine — not
 * configuring the instance. Whoever can change a target can say how it is
 * watched. The global default follows the same permission: it opens no power
 * that the machine-by-machine setting would not already open.
 */

const scopeSchema = z.object({
  /** `null` — or absent — designates the instance's default. */
  targetId: z.string().uuid().nullable().default(null),
});

const putSchema = scopeSchema.extend(upsertThresholdSchema.shape);

const deleteQuerySchema = z.object({
  targetId: z.string().uuid().optional(),
  metric: hostMetricKeySchema,
});

/** The catalog and the settings made. The screen deduces what it shows from them. */
export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'target:read');
  const rows = await listThresholdRows();
  const language = await currentLanguage();

  return NextResponse.json({
    // The defaults are returned explicitly: a screen that only shows the exceptions
    // does not say what applies when there are none.
    catalog: HOST_METRIC_LIST.map((definition) => ({
      metric: definition.key,
      label: definition.label(language),
      defaultLimitPercent: definition.defaultLimitPercent,
      defaultBreachSamples: definition.defaultBreachSamples,
      defaultClearSamples: definition.defaultClearSamples,
    })),
    items: rows,
  });
});

export const PUT = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'target:update');
  const body = await readJsonBody(request, putSchema);

  if (body.targetId !== null) {
    const target = await getTarget(body.targetId);
    if (!target) {
      throw new NotFoundError(
        msg(settings, 'threshold.error.targetNotFound', { id: body.targetId }),
      );
    }
  }

  const row = await upsertThreshold(
    body.targetId,
    {
      metric: body.metric,
      limitPercent: body.limitPercent,
      breachSamples: body.breachSamples,
      clearSamples: body.clearSamples,
      enabled: body.enabled,
    },
    auth.userId,
  );

  // Changing a threshold is changing what will wake someone up at 3 a.m. It gets
  // traced, like everything that changes a target.
  await logAudit({
    actorId: auth.userId,
    action: 'target.threshold.updated',
    resourceType: 'target',
    resourceId: body.targetId ?? 'default',
    after: {
      metric: row.metric,
      limitPercent: row.limitPercent,
      breachSamples: row.breachSamples,
      clearSamples: row.clearSamples,
      enabled: row.enabled,
      scope: body.targetId === null ? 'global' : 'target',
    },
    ip: auth.ip,
  });

  return NextResponse.json(row);
});

/** Removes a setting: the layer below — global, then catalog — takes over again. */
export const DELETE = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'target:update');
  const query = readSearchParams(request, deleteQuerySchema);
  const targetId = query.targetId ?? null;

  const removed = await deleteThreshold(targetId, query.metric);
  if (!removed) throw new NotFoundError(msg(settings, 'threshold.error.notSet'));

  await logAudit({
    actorId: auth.userId,
    action: 'target.threshold.updated',
    resourceType: 'target',
    resourceId: targetId ?? 'default',
    after: { metric: query.metric, removed: true, scope: targetId === null ? 'global' : 'target' },
    ip: auth.ip,
  });

  return NextResponse.json({ ok: true, metric: query.metric, targetId });
});
