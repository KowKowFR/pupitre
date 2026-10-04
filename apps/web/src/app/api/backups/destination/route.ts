import { BACKUP_DESTINATION_CHECK_JOB, backupDestinationKindSchema } from '@pupitre/core';
import {
  disableBackupDestinations,
  getActiveBackupDestination,
  logAudit,
  saveBackupDestination,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { backups as messages } from '@/i18n/messages/backups';
import { getT } from '@/i18n/server';
import { apiRoute, readJsonBody } from '@/lib/http';
import { destinationView } from '@/lib/backups';
import { requirePermission } from '@/lib/rbac';
import { getSupervisionQueue } from '@/lib/supervision-queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * La destination des sauvegardes. Les identifiants ne sortent jamais : la
 * réponse dit **lesquels** sont renseignés (`secretFields`), pas leur valeur.
 * Un champ secret absent du corps est conservé ; une chaîne vide l'efface.
 */
export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'settings:read');
  const destination = await getActiveBackupDestination();
  return NextResponse.json({ destination: destination ? destinationView(destination) : null });
});

const bodySchema = z.object({
  kind: backupDestinationKindSchema,
  name: z.string().trim().min(1).max(80).optional(),
  config: z.record(z.string().max(60), z.union([z.string(), z.number(), z.boolean()])).default({}),
  secrets: z.record(z.string().max(60), z.string().max(16_000)).nullable().default(null),
});

export const PUT = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'settings:manage');
  const body = await readJsonBody(request, bodySchema);
  const input = { ...body, name: body.name ?? (await getT(messages))('destination.defaultName') };
  // `saveBackupDestination` valide l'ensemble — réglages et secrets conservés
  // compris — et lève une `ZodError` (422) sur une destination incomplète.
  const saved = await saveBackupDestination(input);
  await logAudit({
    actorId: auth.userId,
    action: 'backup.destination.updated',
    resourceType: 'settings',
    resourceId: null,
    after: {
      kind: saved.kind,
      name: saved.name,
      destination: destinationView(saved).description,
      secretFields: saved.secretFields,
    },
    ip: auth.ip,
  });
  // Une destination qu'on vient de régler, on la teste tout de suite.
  await getSupervisionQueue().add(BACKUP_DESTINATION_CHECK_JOB, {
    destinationId: saved.id,
    actorId: auth.userId,
    ip: auth.ip,
  });
  return NextResponse.json({ destination: destinationView(saved) });
});

export const DELETE = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'settings:manage');
  const removed = await disableBackupDestinations();
  if (removed > 0) {
    await logAudit({
      actorId: auth.userId,
      action: 'backup.destination.removed',
      resourceType: 'settings',
      resourceId: null,
      ip: auth.ip,
    });
  }
  return NextResponse.json({ removed });
});
