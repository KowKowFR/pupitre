import 'server-only';
import type { Permission } from '@pupitre/core';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ForbiddenError, UnauthenticatedError } from './errors';
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
  return new Request(`${protocol}://${host}${pathname}`, {
    method: 'GET',
    headers: incoming,
  });
}

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
    if (error instanceof UnauthenticatedError) {
      redirect(`/login?next=${encodeURIComponent(pathname)}`);
    }
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
    if (error instanceof UnauthenticatedError) {
      redirect(`/login?next=${encodeURIComponent(pathname)}`);
    }
    if (error instanceof ForbiddenError) {
      redirect(`/forbidden?permission=${encodeURIComponent(permission)}`);
    }
    throw error;
  }
}
