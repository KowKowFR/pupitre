import { AVATAR_EDGE, AVATAR_MAX_BYTES, AVATAR_MEDIA_TYPES, sniffImage } from '@pupitre/core';
import { logAudit, removeUserAvatar, setUserAvatar } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { account as messages } from '@/i18n/messages/account';
import { HttpError, msg } from '@/lib/errors';
import { apiRoute, readLimitedBody } from '@/lib/http';
import { enforceRateLimit, type RateLimitRule } from '@/lib/rate-limit';
import { requireSession } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AVATAR_RULE: RateLimitRule = { name: 'account:avatar', limit: 10, windowSec: 60 };

/** A picture cropped by the browser is 256 px; we leave some margin, no more. */
const AVATAR_MAX_EDGE = AVATAR_EDGE * 4;

/**
 * One's own profile picture: the request body **is** the image
 * (`content-type: image/…`), already cropped into a square and re-encoded by the
 * browser. The server only believes the bytes: format and dimensions are read
 * there, and it is that format which is served again.
 *
 * A session is enough — it is an action on oneself, like the password.
 */
export const PUT = apiRoute(async (request) => {
  const auth = await requireSession(request);
  await enforceRateLimit(AVATAR_RULE, auth.userId);

  const data = await readLimitedBody(request, AVATAR_MAX_BYTES);
  const info = sniffImage(data);
  if (!info || !AVATAR_MEDIA_TYPES.includes(info.contentType)) {
    throw new HttpError(415, 'unsupported_image', msg(messages, 'avatar.error.format'));
  }
  if (info.width > AVATAR_MAX_EDGE || info.height > AVATAR_MAX_EDGE) {
    throw new HttpError(
      422,
      'image_too_large',
      msg(messages, 'avatar.error.dimensions', { max: AVATAR_MAX_EDGE }),
    );
  }

  const image = await setUserAvatar(auth.userId, { ...info, data });
  await logAudit({
    actorId: auth.userId,
    action: 'account.avatar.updated',
    resourceType: 'user',
    resourceId: auth.userId,
    after: {
      contentType: info.contentType,
      width: info.width,
      height: info.height,
      bytes: data.byteLength,
    },
    ip: auth.ip,
  });
  // The audit line is also the real-time signal (`users` topic): the others'
  // screens read themselves again and show the new face.
  return NextResponse.json({ image });
});

export const DELETE = apiRoute(async (request) => {
  const auth = await requireSession(request);
  await enforceRateLimit(AVATAR_RULE, auth.userId);
  const removed = await removeUserAvatar(auth.userId);
  if (removed) {
    await logAudit({
      actorId: auth.userId,
      action: 'account.avatar.removed',
      resourceType: 'user',
      resourceId: auth.userId,
      ip: auth.ip,
    });
  }
  return NextResponse.json({ image: null, removed });
});
