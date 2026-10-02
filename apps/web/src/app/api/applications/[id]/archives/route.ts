import { getApplication, listSourceArchives, logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { archives as messages } from '@/i18n/messages/archives';
import { ConflictError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { enforceRateLimit, type RateLimitRule } from '@/lib/rate-limit';
import { requireApplicationScope, requirePermission } from '@/lib/rbac';
import {
  archiveJson,
  enqueueArchiveInspect,
  isLinkedToRepository,
  receiveArchive,
} from '@/lib/source-archives';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/** Une archive pèse : de quoi itérer vite, pas de quoi remplir la base en boucle. */
const UPLOAD_RULE: RateLimitRule = { name: 'application:archive', limit: 20, windowSec: 600 };

/** Le nom voyage encodé (un en-tête n'accepte que de l'ASCII) ; brut s'il ne l'est pas. */
function headerName(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Les archives d'une application, de la plus récente à la plus ancienne. Jamais leurs octets. */
export const GET = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'application:read', { applicationScoped: true });
  const { id } = paramsSchema.parse(await context.params);
  await requireApplicationScope(request, auth, id);
  if (!(await getApplication(id))) throw new NotFoundError(msg(messages, 'error.notFound', { id }));
  const items = (await listSourceArchives(id)).map(archiveJson);
  return NextResponse.json({ items, total: items.length });
});

/**
 * Téléverse le code de l'application : le corps de la requête **est**
 * l'archive (`.tar.gz`, `.tar` ou `.zip`, reconnue à ses octets), son nom dans
 * l'en-tête `x-archive-name` (encodé comme un composant d'URL). Rend `202` : le worker la lit ensuite, et
 * `status` passe à `ready` ou `rejected`.
 *
 * C'est aussi la route d'une CI qui n'a pas de dépôt lié : un jeton d'API
 * limité à l'application suffit (`application:update`).
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'application:update', { applicationScoped: true });
  const { id } = paramsSchema.parse(await context.params);
  await requireApplicationScope(request, auth, id);
  await enforceRateLimit(UPLOAD_RULE, auth.userId);

  const application = await getApplication(id);
  if (!application) throw new NotFoundError(msg(messages, 'error.notFound', { id }));
  if (await isLinkedToRepository(id)) throw new ConflictError(msg(messages, 'error.linked'));

  const archive = await receiveArchive(request, {
    applicationId: id,
    name: headerName(request.headers.get('x-archive-name')),
    uploadedBy: auth.userId,
  });
  const jobId = await enqueueArchiveInspect(archive.id, auth);

  await logAudit({
    actorId: auth.userId,
    action: 'source_archive.uploaded',
    resourceType: 'source_archive',
    resourceId: archive.id,
    after: {
      application: application.slug,
      applicationId: id,
      name: archive.name,
      format: archive.format,
      bytes: archive.uploadedBytes,
      sha256: archive.sha256,
      jobId,
    },
    ip: auth.ip,
  });

  return NextResponse.json(
    { archive: archiveJson(archive), jobId },
    { status: 202, headers: { location: `/api/applications/${id}/archives/${archive.id}` } },
  );
});
