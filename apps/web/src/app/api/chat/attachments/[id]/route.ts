import { imageExtension, imageResponseHeaders } from '@pupitre/core';
import { getChatAttachmentData } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { chat as messages } from '@/i18n/messages/chat';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requireSession } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * Une image de la discussion. Les mêmes portes que le fil : une session suffit.
 * Immuable — une image jointe ne change jamais —, donc gardée en cache, mais
 * `private` : elle n'a rien à faire dans un cache partagé. Celle d'un message
 * effacé n'existe plus (404) : ses octets sont partis avec lui.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  await requireSession(request);
  const { id } = paramsSchema.parse(await context.params);

  const attachment = await getChatAttachmentData(id);
  if (!attachment) throw new NotFoundError(msg(messages, 'error.imageNotFound'));

  return new NextResponse(new Uint8Array(attachment.data), {
    status: 200,
    headers: imageResponseHeaders({
      contentType: attachment.contentType,
      bytes: attachment.bytes,
      filename: `image-${id}.${imageExtension(attachment.contentType)}`,
      immutable: true,
    }),
  });
});
