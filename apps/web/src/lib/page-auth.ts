import 'server-only';
import type { Permission } from '@pupitre/core';
import { getSessionCookie } from 'better-auth/cookies';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ForbiddenError, TwoFactorRequiredError, UnauthenticatedError } from './errors';
import { requirePermission, requireSession, type AuthContext } from './rbac';

/**
 * Adaptateur pour les Server Components : `requirePermission()` raisonne sur
 * une `Request`, les pages n'en ont pas. On en fabrique une à partir des
 * en-têtes entrants, de sorte que le même helper — et le même audit — serve
 * pour l'API et pour les pages.
 */
async function requestFromHeaders(pathname: string): Promise<Request> {
  const incoming = await headers();
  const host = incoming.get('host') ?? 'localhost';
  const protocol = incoming.get('x-forwarded-proto') ?? 'http';
  // Une page ne se lit qu'avec une session de navigateur : un jeton d'API
  // ouvre l'API, pas l'interface.
  const forwarded = new Headers(incoming);
  forwarded.delete('authorization');
  return new Request(`${protocol}://${host}${pathname}`, {
    method: 'GET',
    headers: forwarded,
  });
}

/**
 * Renvoie vers l'écran de connexion, en gardant la page demandée.
 *
 * Quand le navigateur porte encore un cookie de session que le serveur ne
 * reconnaît plus — session fermée depuis « Mon compte », expirée, tombée avec
 * une réinitialisation du second facteur —, on passe d'abord par `/logout`,
 * qui efface le cookie. Sans ce détour, le proxy, qui ne voit que la
 * *présence* du cookie, renverrait `/login` vers `/`, puis `/` vers `/login`,
 * sans fin.
 */
export async function redirectToLogin(pathname?: string): Promise<never> {
  const incoming = await headers();
  // Sans chemin explicite (un layout), celui que le proxy a transmis.
  const target = pathname ?? incoming.get('x-pupitre-path') ?? null;
  const query = target && target !== '/' ? `?next=${encodeURIComponent(target)}` : '';
  const stale = getSessionCookie(incoming) !== null;
  redirect(`${stale ? '/logout' : '/login'}${query}`);
}

/**
 * Où va un compte dont le rôle exige un second facteur qu'il n'a pas encore.
 * Hors du groupe `(app)`, comme l'assistant de démarrage : une redirection
 * posée par le layout `(app)` vers une page qu'il enveloppe ferait boucler le
 * routeur client — il croirait le layout déjà rendu et ne le redemanderait pas.
 */
export const TWO_FACTOR_ENROLL_PATH = '/two-factor-setup';

/** Contexte courant, ou `null` si non authentifié. Ne redirige pas. */
export async function currentAuth(pathname = '/'): Promise<AuthContext | null> {
  try {
    return await requireSession(await requestFromHeaders(pathname));
  } catch {
    return null;
  }
}

/** Exige une session pour afficher la page ; redirige vers `/login` sinon. */
export async function requirePageSession(pathname: string): Promise<AuthContext> {
  try {
    return await requireSession(await requestFromHeaders(pathname));
  } catch (error) {
    if (error instanceof UnauthenticatedError) await redirectToLogin(pathname);
    throw error;
  }
}

/** Exige une permission pour afficher la page. Le refus est audité. */
export async function requirePagePermission(
  pathname: string,
  permission: Permission,
): Promise<AuthContext> {
  try {
    return await requirePermission(await requestFromHeaders(pathname), permission);
  } catch (error) {
    if (error instanceof UnauthenticatedError) await redirectToLogin(pathname);
    if (error instanceof TwoFactorRequiredError) redirect(TWO_FACTOR_ENROLL_PATH);
    if (error instanceof ForbiddenError) {
      redirect(`/forbidden?permission=${encodeURIComponent(permission)}`);
    }
    throw error;
  }
}
