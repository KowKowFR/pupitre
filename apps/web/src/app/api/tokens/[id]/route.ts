import { getApiToken, logAudit, revokeApiToken } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiTokens as messages } from '@/i18n/messages/api-tokens';
import { toApiTokenDto } from '@/lib/api-tokens';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission, requireTeamMember } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * Révoque un jeton : le sien, ou — avec `user:manage` — celui de quelqu'un
 * d'autre. Depuis le panel seulement. Le jeton reste en base, révoqué : le
 * journal continue de dire lequel a agi.
 */
export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requireTeamMember(request);
  const { id } = paramsSchema.parse(await context.params);

  const token = await getApiToken(id);
  if (!token) throw new NotFoundError(msg(messages, 'error.notFound'));
  const own = token.userId === auth.userId;
  if (!own) await requirePermission(request, 'user:manage', { sessionOnly: true });

  if (await revokeApiToken(id)) {
    await logAudit({
      actorId: auth.userId,
      action: 'api_token.revoked',
      resourceType: 'api_token',
      resourceId: id,
      after: { name: token.name, prefix: token.prefix, ownerEmail: token.ownerEmail, own },
      ip: auth.ip,
    });
  }

  const after = await getApiToken(id);
  return NextResponse.json({ item: after ? toApiTokenDto(after) : null });
});
