import 'server-only';
import type { ApiTokenView } from '@pupitre/db';

/** The offered expiries, in days. `null`: without expiry. */
export const API_TOKEN_EXPIRIES = [30, 90, 365] as const;

/** Enough for one CI per repository, not enough to stop knowing what each one is for. */
export const MAX_LIVE_API_TOKENS = 25;

export type ApiTokenStatus = 'active' | 'revoked' | 'expired';

/** A token as the screen sees it — never the token itself. */
export type ApiTokenDto = {
  id: string;
  name: string;
  prefix: string;
  permissions: string[];
  applicationIds: string[] | null;
  status: ApiTokenStatus;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
  createdAt: string;
  owner: { id: string; email: string; name: string };
};

export function apiTokenStatus(
  token: Pick<ApiTokenView, 'revokedAt' | 'expiresAt'>,
  now: number = Date.now(),
): ApiTokenStatus {
  if (token.revokedAt) return 'revoked';
  if (token.expiresAt && token.expiresAt.getTime() <= now) return 'expired';
  return 'active';
}

export function toApiTokenDto(token: ApiTokenView): ApiTokenDto {
  return {
    id: token.id,
    name: token.name,
    prefix: token.prefix,
    permissions: token.permissions,
    applicationIds: token.applicationIds ?? null,
    status: apiTokenStatus(token),
    expiresAt: token.expiresAt?.toISOString() ?? null,
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    lastUsedIp: token.lastUsedIp,
    revokedAt: token.revokedAt?.toISOString() ?? null,
    createdAt: token.createdAt.toISOString(),
    owner: { id: token.userId, email: token.ownerEmail, name: token.ownerName },
  };
}
