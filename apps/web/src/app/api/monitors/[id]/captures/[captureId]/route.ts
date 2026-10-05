import { getCaptureBytes } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { monitors as messages } from '@/i18n/messages/monitors';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid(), captureId: z.string().uuid() });
type Context = { params: Promise<{ id: string; captureId: string }> };

/**
 * Serves a capture's image.
 *
 * ── Why a route and not a data URL in the page ──────────────────────────────
 * A capture weighs a few hundred kilobytes; a probe's screen shows up to three per
 * incident. Embedding them as `data:` in the HTML rendered by the server would
 * make pages of several megabytes, not cacheable, downloaded again at each
 * navigation. A route makes them cacheable per image and loadable on demand.
 *
 * ── What it protects ────────────────────────────────────────────────────────
 * `monitor:read`, like the rest of monitoring, and **the permission is checked
 * before any byte is read**. A capture shows the page as an anonymous visitor
 * sees it — the browser carries no session — but a monitored URL that itself
 * contains a token will make private content appear in the image. This image
 * must therefore never become public: no access through a URL token, no shared
 * cache, no attachment in an alert.
 *
 * The probe's identifier is in the path **and** checked against the capture:
 * without this check, the route would be an instance-wide enumeration of images,
 * with a path that claims the opposite.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'monitor:read');
  const { id, captureId } = paramsSchema.parse(await context.params);

  const capture = await getCaptureBytes(captureId);
  // A capture purged by retention returns `null`: it has no bytes any more, and
  // the screen already says so from the metadata. 404 is the right answer.
  if (!capture || capture.monitorId !== id) {
    throw new NotFoundError(msg(messages, 'error.captureNotFound', { id: captureId }));
  }

  return new NextResponse(new Uint8Array(capture.image), {
    status: 200,
    headers: {
      'content-type': capture.format === 'png' ? 'image/png' : 'image/jpeg',
      'content-length': String(capture.image.byteLength),
      // A capture is **immutable**: its bytes never change after writing. The cache
      // can therefore be long — but `private`, because the image is protected by a
      // permission and has no business in a shared cache.
      'cache-control': 'private, max-age=31536000, immutable',
      // Rendered, never interpreted: a captured page is third-party content.
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': `inline; filename="capture-${captureId}.${capture.format}"`,
    },
  });
});
