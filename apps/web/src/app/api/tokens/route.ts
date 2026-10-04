import { isPermission } from '@pupitre/core';
import {
  countLiveApiTokens,
  createApiToken,
  getApplication,
  listApiTokens,
  logAudit,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiTokens as messages } from '@/i18n/messages/api-tokens';
import { generateApiToken } from '@/lib/api-token-format';
import { API_TOKEN_EXPIRIES, MAX_LIVE_API_TOKENS, toApiTokenDto } from '@/lib/api-tokens';
import { ConflictError, ForbiddenError, HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requireTeamMember } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * One's own API tokens. Browser session only: a token does not make other tokens.
 */
export const GET = apiRoute(async (request) => {
  const auth = await requireTeamMember(request);
  const items = await listApiTokens({ userId: auth.userId });
  return NextResponse.json({ items: items.map(toApiTokenDto) });
});

const expirySchema = z.union(
  API_TOKEN_EXPIRIES.map((days) => z.literal(days)) as unknown as [
    z.ZodLiteral<30>,
    z.ZodLiteral<90>,
    z.ZodLiteral<365>,
  ],
);

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  permissions: z.array(z.string().min(1).max(60)).min(1).max(64),
  /** `null` : toutes les applications. */
  applicationIds: z.array(z.string().uuid()).min(1).max(100).nullable().default(null),
  /** In days; `null`: without expiry. */
  expiresInDays: expirySchema.nullable().default(90),
});

/**
 * Creates a token. It is returned **only here**, once: the database only keeps
 * its fingerprint.
 *
 * Its permissions are taken among its author's: asking for what one does not have
 * is refused, rather than silently reduced — a token that cannot do what one
 * believes is a CI that fails later, without anyone knowing why.
 */
export const POST = apiRoute(async (request) => {
  const auth = await requireTeamMember(request);
  const input = await readJsonBody(request, createSchema);

  const permissions = [...new Set(input.permissions)];
  for (const key of permissions) {
    if (!isPermission(key)) {
      throw new HttpError(
        422,
        'unknown_permission',
        msg(messages, 'error.unknownPermission', { permission: key }),
      );
    }
    if (!auth.can(key)) throw new ForbiddenError(key);
  }

  const applicationIds = input.applicationIds ? [...new Set(input.applicationIds)] : null;
  if (applicationIds) {
    const found = await Promise.all(applicationIds.map((id) => getApplication(id)));
    const missing = applicationIds.find((_, index) => !found[index]);
    if (missing) {
      throw new NotFoundError(msg(messages, 'error.applicationNotFound', { id: missing }));
    }
  }

  if ((await countLiveApiTokens(auth.userId)) >= MAX_LIVE_API_TOKENS) {
    throw new ConflictError(msg(messages, 'error.tooMany', { max: MAX_LIVE_API_TOKENS }));
  }

  const { token, prefix, hash } = generateApiToken();
  const expiresAt =
    input.expiresInDays === null ? null : new Date(Date.now() + input.expiresInDays * 86_400_000);
  const row = await createApiToken({
    userId: auth.userId,
    name: input.name,
    prefix,
    tokenHash: hash,
    permissions,
    applicationIds,
    expiresAt,
  });

  // The prefix, never the token: the log gets read, exported and shared.
  await logAudit({
    actorId: auth.userId,
    action: 'api_token.created',
    resourceType: 'api_token',
    resourceId: row.id,
    after: {
      name: row.name,
      prefix,
      ownerEmail: auth.email,
      permissions,
      applicationIds,
      expiresAt: expiresAt?.toISOString() ?? null,
    },
    ip: auth.ip,
  });

  return NextResponse.json(
    { token, item: toApiTokenDto({ ...row, ownerEmail: auth.email, ownerName: auth.name }) },
    { status: 201, headers: { 'cache-control': 'no-store' } },
  );
});
