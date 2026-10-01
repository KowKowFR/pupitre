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

/** Une photo recadrée par le navigateur fait 256 px ; on laisse de la marge, pas plus. */
const AVATAR_MAX_EDGE = AVATAR_EDGE * 4;

/**
 * Sa propre photo de profil : le corps de la requête **est** l'image
 * (`content-type: image/…`), déjà recadrée en carré et réencodée par le
 * navigateur. Le serveur ne croit que les octets : format et dimensions y sont
 * lus, et c'est ce format-là qui est resservi.
 *
 * Une session suffit — c'est une action sur soi, comme le mot de passe.
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
  // La ligne d'audit est aussi le signal temps réel (sujet `users`) : les
  // écrans des autres se relisent et montrent le nouveau visage.
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
