import { imageExtension, imageResponseHeaders } from '@pupitre/core';
import { getChatAttachmentData } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { chat as messages } from '@/i18n/messages/chat';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requireTeamMember } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * A chat image. The same doors as the thread: a session is enough. Immutable — an
 * attached image never changes —, hence kept in cache, but `private`: it has no
 * business in a shared cache. A deleted message's image no longer exists (404):
 * its bytes went with it.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  await requireTeamMember(request);
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
