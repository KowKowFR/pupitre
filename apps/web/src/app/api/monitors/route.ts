import {
  MONITOR_CHECK_RETENTION_DAYS,
  MONITOR_FAILURE_THRESHOLD_DEFAULT,
  MONITOR_RECOVERY_THRESHOLD_DEFAULT,
  MONITOR_TYPES_LIST,
} from '@tp/core';
import {
  MonitorConfigError,
  createMonitor,
  createMonitorSchema,
  getApplication,
  listAdoptableApps,
  listMonitors,
  logAudit,
  monitorTarget,
} from '@tp/db';
import { NextResponse } from 'next/server';
import { HttpError, NotFoundError } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import {
  assertConfigAllowed,
  assertUrlAllowed,
  buildMonitorViews,
  monitorTypeOptions,
} from '@/lib/monitors';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Sondes de supervision.
 *
 * ── Le lien avec les déploiements ────────────────────────────────────────────
 * Le panel connaît déjà l'URL de tout ce qu'il déploie. Il **ne crée pourtant
 * pas la sonde tout seul**, et c'est un choix :
 *
 *   - Créer automatiquement veut dire pouvoir annuler. Or une sonde auto-créée
 *     que l'opérateur supprime réapparaîtrait au déploiement suivant, à moins
 *     de tenir une table de pierres tombales — un troisième objet, pour une
 *     commodité.
 *   - Une sonde émet du trafic sortant depuis le worker, à la minute, vers une
 *     cible. Ce n'est pas un effet de bord qu'un `POST /api/deployments`
 *     devrait produire sans qu'on l'ait demandé.
 *   - Le geste de déploiement vit dans `apps/worker/src/deploy/`, hors du
 *     périmètre de ce chantier : l'y brancher aurait été un branchement en
 *     terrain occupé.
 *
 * À la place : `GET` renvoie `adoptable`, la liste des applications déployées,
 * joignables et pas encore supervisées. L'écran en fait un bouton « Superviser »
 * qui pré-remplit tout. Un clic, et l'opérateur sait ce qu'il a créé.
 *
 * Dans l'autre sens, le lien est automatique : la sonde d'une application
 * détruite est **suspendue** par le balayage, avec son motif, plutôt que de
 * hurler à la panne. Elle se reprend d'un clic.
 */

function translate(error: unknown): never {
  if (error instanceof MonitorConfigError) {
    throw new HttpError(422, 'validation_failed', error.message, { field: error.field });
  }
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
    // Le catalogue est **envoyé au client** : c'est lui qui dit à l'écran quels
    // champs afficher pour chaque type. Sans ça il faudrait un `if` par type
    // dans le formulaire, et ajouter un type deviendrait une chirurgie.
    types: monitorTypeOptions(MONITOR_TYPES_LIST),
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

  // La garde SSRF, à la création. Le worker la refait à chaque saut : une garde
  // qui ne tient qu'ici n'en serait pas une.
  await assertConfigAllowed(input.type, input.config);
  if (input.webhookUrl) await assertUrlAllowed(input.webhookUrl, 'webhookUrl');

  if (input.applicationId !== null) {
    const application = await getApplication(input.applicationId);
    if (!application) {
      throw new NotFoundError(`Application « ${input.applicationId} » introuvable`);
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
      // Jamais l'URL du webhook : c'est un secret, et un journal d'audit se lit.
      hasWebhook: row.webhookUrlEncrypted !== null,
    },
    ip: auth.ip,
  });

  const [item] = await buildMonitorViews([row]);
  return NextResponse.json(item, { status: 201 });
});
