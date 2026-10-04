import { imageExtension, imageResponseHeaders } from '@pupitre/core';
import { getUserAvatar } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { account as messages } from '@/i18n/messages/account';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requireSession } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().min(1).max(200) });
type Context = { params: Promise<{ id: string }> };

/**
 * A person's profile picture. A session is enough: whoever sees the person in the
 * team sees their face.
 *
 * The URL the panel publishes carries `?v=` — a version drawn from the content.
 * With it, the response is immutable and kept for a year; without it, it is
 * revalidated.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  await requireSession(request);
  const { id } = paramsSchema.parse(await context.params);

  const avatar = await getUserAvatar(id);
  if (!avatar) throw new NotFoundError(msg(messages, 'avatar.error.notFound'));

  return new NextResponse(new Uint8Array(avatar.data), {
    status: 200,
    headers: imageResponseHeaders({
      contentType: avatar.contentType,
      bytes: avatar.bytes,
      filename: `avatar.${imageExtension(avatar.contentType)}`,
      immutable: new URL(request.url).searchParams.has('v'),
    }),
  });
});
