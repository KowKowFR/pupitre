import { createHash, randomBytes } from 'node:crypto';

/**
 * Le format d'un jeton d'API : `pup_` puis 32 octets d'aléa en base64url.
 *
 * Le préfixe n'est pas décoratif : il dit d'où vient un jeton trouvé dans un
 * journal ou un dépôt, et le rend reconnaissable par un outil de détection de
 * secrets. Les huit caractères qui le suivent servent à le désigner à l'écran
 * sans le révéler.
 */
export const API_TOKEN_PREFIX = 'pup_';

const TOKEN_PATTERN = /^pup_[A-Za-z0-9_-]{43}$/;

export function generateApiToken(): { token: string; prefix: string; hash: string } {
  const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, prefix: token.slice(0, API_TOKEN_PREFIX.length + 8), hash: hashApiToken(token) };
}

/**
 * L'empreinte rangée en base. Un SHA-256 simple suffit : le jeton porte
 * 256 bits d'aléa, il n'y a rien à deviner et donc rien à ralentir — ce qui
 * justifie un hachage lent pour un mot de passe ne s'applique pas ici.
 */
export function hashApiToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Ce que dit l'en-tête `Authorization` :
 *   - `null` : pas d'en-tête, ou un autre schéma que `Bearer` — la requête
 *     s'authentifie autrement (par sa session) ;
 *   - `'malformed'` : un `Bearer` qui n'a pas la forme d'un jeton Pupitre ;
 *   - le jeton sinon.
 */
export function bearerToken(headers: Pick<Headers, 'get'>): string | 'malformed' | null {
  const header = headers.get('authorization');
  if (header === null) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  if (!match) return /^Bearer\b/i.test(header.trim()) ? 'malformed' : null;
  const token = match[1]!;
  return TOKEN_PATTERN.test(token) ? token : 'malformed';
}
