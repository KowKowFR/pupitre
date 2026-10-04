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
 * Canaux de notification.
 *
 * `settings:read` / `settings:manage` : configurer où partent les alertes est
 * un réglage d'instance, au même titre que la politique de scan. Rien ici
 * n'ouvre un pouvoir que `settings:manage` ne donne pas déjà.
 *
 * Les secrets — mot de passe SMTP, jeton de bot, URL de webhook Discord — ne
 * sont **jamais** renvoyés, pas même partiellement masqués : la réponse dit
 * seulement *quels champs* sont renseignés. Ce que `@pupitre/db` expose en lecture
 * ne contient physiquement pas les valeurs, donc aucun oubli de filtrage ici ne
 * peut les laisser fuir.
 */

/**
 * Une configuration de canal est un objet plat de scalaires. Le schéma précis
 * — champs attendus, obligation, format — vit dans le catalogue de `@pupitre/core`
 * et est appliqué par `@pupitre/db` : le dupliquer ici donnerait deux vérités.
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
 * Vocabulaire nécessaire à l'écran — aucune liste figée côté client.
 *
 * La langue traverse la route : ces libellés sont ceux des champs du
 * formulaire de canal, pas des codes. Sans elle, le catalogue retombait sur sa
 * langue source et posait « Serveur SMTP » au milieu d'un écran anglais.
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
   * L'audit porte la configuration en clair — elle n'a rien de secret — mais
   * les secrets y sont réduits à la liste des champs renseignés. Une entrée
   * d'audit est lue par beaucoup de monde et conservée longtemps : c'est le
   * dernier endroit où l'on voudrait retrouver un jeton.
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
      // i18n-ignore — charge utile d'audit, figée à l'écriture (cf. `api/settings`).
      secrets: channel.configuredSecrets.map((field) => `${field} (défini)`),
    },
    ip: auth.ip,
  });

  return NextResponse.json(channel, { status: 201 });
});
