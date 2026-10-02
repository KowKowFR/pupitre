import {
  deleteSourceArchive,
  getApplication,
  getSourceArchive,
  logAudit,
  sourceArchiveInFlight,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { archives as messages } from '@/i18n/messages/archives';
import { ConflictError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requireApplicationScope, requirePermission } from '@/lib/rbac';
import { archiveJson } from '@/lib/source-archives';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid(), archiveId: z.string().uuid() });
type Context = { params: Promise<{ id: string; archiveId: string }> };

async function archiveOf(id: string, archiveId: string) {
  const archive = await getSourceArchive(archiveId);
  if (!archive || archive.applicationId !== id) {
    throw new NotFoundError(msg(messages, 'error.archiveNotFound', { id: archiveId }));
  }
  return archive;
}

/** Une archive : son état, le rapport de sa lecture — ce qu'une CI interroge après l'envoi. */
export const GET = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'application:read', { applicationScoped: true });
  const { id, archiveId } = paramsSchema.parse(await context.params);
  await requireApplicationScope(request, auth, id);
  return NextResponse.json({ archive: archiveJson(await archiveOf(id, archiveId)) });
});

/**
 * Efface une archive et ses octets. Les versions qui l'ont construite gardent
 * son nom et son empreinte, mais ne se redéploient plus. Refusé tant qu'un
 * déploiement en cours la construit.
 */
export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'application:update', { applicationScoped: true });
  const { id, archiveId } = paramsSchema.parse(await context.params);
  await requireApplicationScope(request, auth, id);
  const archive = await archiveOf(id, archiveId);
  if (await sourceArchiveInFlight(archive.id)) {
    throw new ConflictError(msg(messages, 'error.inFlight'));
  }

  await deleteSourceArchive(archive.id);
  const application = await getApplication(id);
  await logAudit({
    actorId: auth.userId,
    action: 'source_archive.deleted',
    resourceType: 'source_archive',
    resourceId: archive.id,
    before: {
      application: application?.slug ?? null,
      applicationId: id,
      name: archive.name,
      status: archive.status,
      sha256: archive.sha256,
    },
    ip: auth.ip,
  });
  return NextResponse.json({ deleted: true });
});
