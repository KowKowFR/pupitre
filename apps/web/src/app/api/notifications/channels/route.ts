import {
  NOTIFICATION_EVENT_KEYS,
  notificationChannelKindSchema,
  presentNotificationChannels,
  presentNotificationEvents,
} from '@pupitre/core';
import {
  NotificationChannelNameTakenError,
  createNotificationChannel,
  listNotificationChannels,
} from '@pupitre/db';
import { logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { currentLanguage } from '@/i18n/server';
import { notifications } from '@/i18n/messages/notifications';
import { ConflictError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Notification channels.
 *
 * `settings:read` / `settings:manage`: configuring where the alerts go is an
 * instance setting, just like the scan policy. Nothing here opens a power that
 * `settings:manage` does not already give.
 *
 * The secrets — SMTP password, bot token, Discord webhook URL — are **never**
 * returned, not even partially masked: the response only says *which fields* are
 * filled in. What `@pupitre/db` exposes for reading physically does not contain
 * the values, so no filtering omission here can let them leak.
 */

/**
 * A channel configuration is a flat object of scalars. The precise schema —
 * expected fields, requirement, format — lives in `@pupitre/core`'s catalog and
 * is applied by `@pupitre/db`: duplicating it here would give two truths.
 */
const configSchema = z.record(z.string().max(60), z.union([z.string(), z.number(), z.boolean()]));
const secretsSchema = z.record(z.string().max(60), z.string().max(400));

const createSchema = z.object({
  kind: notificationChannelKindSchema,
  name: z.string().trim().min(1).max(60),
  enabled: z.boolean().default(true),
  config: configSchema.default({}),
  secrets: secretsSchema.default({}),
  events: z.array(z.enum(NOTIFICATION_EVENT_KEYS)).max(NOTIFICATION_EVENT_KEYS.length).default([]),
});

/**
 * The vocabulary the screen needs — no frozen list on the client side.
 *
 * The language crosses the route: these labels are those of the channel form's
 * fields, not codes. Without it, the catalog fell back on its source language
 * and put "Serveur SMTP" in the middle of an English screen.
 */
async function vocabulary() {
  const language = await currentLanguage();
  return {
    channels: presentNotificationChannels(language),
    events: presentNotificationEvents(language),
  };
}

export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'settings:read');
  const items = await listNotificationChannels();
  return NextResponse.json({ items, vocabulary: await vocabulary() });
});

export const POST = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'settings:manage');
  const body = await readJsonBody(request, createSchema);

  const channel = await createNotificationChannel(
    {
      kind: body.kind,
      name: body.name,
      enabled: body.enabled,
      config: body.config,
      secrets: body.secrets,
      events: body.events,
    },
    auth.userId,
  ).catch((error: unknown) => {
    if (error instanceof NotificationChannelNameTakenError) {
      throw new ConflictError(msg(notifications, 'error.nameTaken', { name: error.channelName }));
    }
    throw error;
  });

  /**
   * The audit carries the configuration in clear — it has nothing secret — but the
   * secrets are reduced to the list of filled in fields. An audit entry is read by
   * many people and kept for a long time: it is the last place one would want to
   * find a token.
   */
  await logAudit({
    actorId: auth.userId,
    action: 'notification.channel.created',
    resourceType: 'notification_channel',
    resourceId: channel.id,
    after: {
      kind: channel.kind,
      name: channel.name,
      enabled: channel.enabled,
      config: channel.config,
      events: channel.events,
      // i18n-ignore — audit payload, frozen at write time (see `api/settings`).
      secrets: channel.configuredSecrets.map((field) => `${field} (set)`),
    },
    ip: auth.ip,
  });

  return NextResponse.json(channel, { status: 201 });
});
