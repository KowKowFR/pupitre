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

/** An archive weighs: enough to iterate quickly, not enough to fill the database in a loop. */
const UPLOAD_RULE: RateLimitRule = { name: 'application:archive', limit: 20, windowSec: 600 };

/** The name travels encoded (a header only accepts ASCII); raw if it is not. */
function headerName(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** An application's archives, from the most recent to the oldest. Never their bytes. */
export const GET = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'application:read', { applicationScoped: true });
  const { id } = paramsSchema.parse(await context.params);
  await requireApplicationScope(request, auth, id);
  if (!(await getApplication(id))) throw new NotFoundError(msg(messages, 'error.notFound', { id }));
  const items = (await listSourceArchives(id)).map(archiveJson);
  return NextResponse.json({ items, total: items.length });
});

/**
 * Uploads the application's code: the request body **is** the archive (`.tar.gz`,
 * `.tar` or `.zip`, recognized by its bytes), its name in the `x-archive-name`
 * header (encoded as a URL component). Returns `202`: the worker reads it next,
 * and `status` moves to `ready` or `rejected`.
 *
 * It is also the route of a CI that has no linked repository: an API token
 * limited to the application is enough (`application:update`).
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
