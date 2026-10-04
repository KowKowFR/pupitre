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
 * Les seuils de la supervision de serveurs.
 *
 * ── Pourquoi une route et pas seulement une constante ───────────────────────
 * « Un seuil qu'on ne peut pas régler est un seuil qu'on désactive. » Un serveur
 * de build vit à 95 % de disque par construction ; sans réglage, l'exploitant
 * apprend en une semaine à ignorer les alertes — et ignorera aussi la vraie.
 *
 * ── Pourquoi trois couches ──────────────────────────────────────────────────
 *   catalogue → toujours présent, donc une instance neuve alerte sans réglage
 *   global    → `targetId: null`, le comportement de la boîte
 *   machine   → l'exception, là où elle se justifie
 * La résolution est faite en base (`resolveThresholds`), jamais recopiée ici.
 *
 * ── Pourquoi `target:update` et pas `settings:manage` ───────────────────────
 * Régler à partir de quand une machine est en peine, c'est décrire cette
 * machine — pas configurer l'instance. Qui peut modifier une cible peut dire
 * comment on la surveille. Le défaut global suit la même permission : il n'ouvre
 * aucun pouvoir que le réglage machine par machine n'ouvrirait déjà.
 */

const scopeSchema = z.object({
  /** `null` — ou absent — désigne le défaut de l'instance. */
  targetId: z.string().uuid().nullable().default(null),
});

const putSchema = scopeSchema.extend(upsertThresholdSchema.shape);

const deleteQuerySchema = z.object({
  targetId: z.string().uuid().optional(),
  metric: hostMetricKeySchema,
});

/** Le catalogue et les réglages posés. L'écran en déduit ce qu'il affiche. */
export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'target:read');
  const rows = await listThresholdRows();
  const language = await currentLanguage();

  return NextResponse.json({
    // Les défauts sont rendus explicitement : un écran qui n'affiche que les
    // exceptions ne dit pas ce qui s'applique quand il n'y en a aucune.
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

  // Changer un seuil, c'est changer ce qui réveillera quelqu'un à 3 h du matin.
  // Ça se trace, comme tout ce qui modifie une cible.
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

/** Retire un réglage : la couche du dessous — global, puis catalogue — reprend. */
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
