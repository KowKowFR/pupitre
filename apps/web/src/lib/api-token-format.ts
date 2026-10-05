import { createHash, randomBytes } from 'node:crypto';

/**
 * An API token's format: `pup_` then 32 random bytes in base64url.
 *
 * The prefix is not decorative: it says where a token found in a log or a
 * repository comes from, and makes it recognizable by a secret detection tool.
 * The eight characters that follow it serve to designate it on screen without
 * revealing it.
 */
export const API_TOKEN_PREFIX = 'pup_';

const TOKEN_PATTERN = /^pup_[A-Za-z0-9_-]{43}$/;

export function generateApiToken(): { token: string; prefix: string; hash: string } {
  const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, prefix: token.slice(0, API_TOKEN_PREFIX.length + 8), hash: hashApiToken(token) };
}

/**
 * The fingerprint stored in the database. A plain SHA-256 is enough: the token
 * carries 256 bits of randomness, there is nothing to guess and therefore nothing
 * to slow down — what justifies a slow hash for a password does not apply here.
 */
export function hashApiToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * What the `Authorization` header says:
 *   - `null`: no header, or another scheme than `Bearer` — the request
 *     authenticates otherwise (through its session);
 *   - `'malformed'`: a `Bearer` that does not have the shape of a Pupitre token;
 *   - the token otherwise.
 */
export function bearerToken(headers: Pick<Headers, 'get'>): string | 'malformed' | null {
  const header = headers.get('authorization');
  if (header === null) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  if (!match) return /^Bearer\b/i.test(header.trim()) ? 'malformed' : null;
  const token = match[1]!;
  return TOKEN_PATTERN.test(token) ? token : 'malformed';
}
