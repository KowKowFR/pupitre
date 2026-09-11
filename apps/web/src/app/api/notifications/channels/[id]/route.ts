import { NOTIFICATION_EVENT_KEYS } from '@tp/core';
import {
  NotificationChannelNameTakenError,
  deleteNotificationChannel,
  getNotificationChannel,
  logAudit,
  updateNotificationChannel,
} from '@tp/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ConflictError, NotFoundError } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

const configSchema = z.record(z.string().max(60), z.union([z.string(), z.number(), z.boolean()]));

/**
 * Trois intentions par champ secret, et le schéma doit les préserver :
 *   champ absent → inchangé
 *   `null`       → effacé
 *   chaîne       → remplacé
 * Même sémantique que `aiApiKey` sur `PATCH /api/settings`, et pour la même
 * raison : sans elle, rouvrir l'écran et enregistrer effacerait le jeton.
 */
const patchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  enabled: z.boolean().optional(),
  config: configSchema.optional(),
  secrets: z.record(z.string().max(60), z.string().max(400).nullable()).optional(),
  events: z
    .array(z.enum(NOTIFICATION_EVENT_KEYS))
    .max(NOTIFICATION_EVENT_KEYS.length)
    .optional(),
});

export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'settings:read');
  const { id } = paramsSchema.parse(await context.params);

  const channel = await getNotificationChannel(id);
  if (!channel) throw new NotFoundError(`Canal « ${id} » introuvable`);

  return NextResponse.json(channel);
});

export const PATCH = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'settings:manage');
  const { id } = paramsSchema.parse(await context.params);
  const patch = await readJsonBody(request, patchSchema);

  const before = await getNotificationChannel(id);
  if (!before) throw new NotFoundError(`Canal « ${id} » introuvable`);

  const after = await updateNotificationChannel(id, patch).catch((error: unknown) => {
    if (error instanceof NotificationChannelNameTakenError) {
      throw new ConflictError(error.message);
    }
    throw error;
  });
  if (!after) throw new NotFoundError(`Canal « ${id} » introuvable`);

  await logAudit({
    actorId: auth.userId,
    action: 'notification.channel.updated',
    resourceType: 'notification_channel',
    resourceId: id,
    before: {
      name: before.name,
      enabled: before.enabled,
      config: before.config,
      events: before.events,
      secrets: before.configuredSecrets,
    },
    after: {
      name: after.name,
      enabled: after.enabled,
      config: after.config,
      events: after.events,
      secrets: after.configuredSecrets,
      // On dit que des secrets ont changé, jamais lesquels ni en quoi.
      secretsTouched: Object.keys(patch.secrets ?? {}).length > 0,
    },
    ip: auth.ip,
  });

  return NextResponse.json(after);
});

export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'settings:manage');
  const { id } = paramsSchema.parse(await context.params);

  const removed = await deleteNotificationChannel(id);
  if (!removed) throw new NotFoundError(`Canal « ${id} » introuvable`);

  await logAudit({
    actorId: auth.userId,
    action: 'notification.channel.deleted',
    resourceType: 'notification_channel',
    resourceId: id,
    before: { kind: removed.kind, name: removed.name, events: removed.events },
    ip: auth.ip,
  });

  return NextResponse.json({ id, deleted: true });
});
