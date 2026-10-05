import 'server-only';
import type { Permission } from '@pupitre/core';
import { getSessionCookie } from 'better-auth/cookies';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ForbiddenError, TwoFactorRequiredError, UnauthenticatedError } from './errors';
import { requirePermission, requireSession, type AuthContext } from './rbac';

/**
 * An adapter for Server Components: `requirePermission()` reasons on a `Request`,
 * the pages do not have one. We make one from the incoming headers, so that the
 * same helper — and the same audit — serves for the API and for the pages.
 */
async function requestFromHeaders(pathname: string): Promise<Request> {
  const incoming = await headers();
  const host = incoming.get('host') ?? 'localhost';
  const protocol = incoming.get('x-forwarded-proto') ?? 'http';
  // A page is only read with a browser session: an API token opens the API, not the
  // interface.
  const forwarded = new Headers(incoming);
  forwarded.delete('authorization');
  return new Request(`${protocol}://${host}${pathname}`, {
    method: 'GET',
    headers: forwarded,
  });
}

/**
 * Sends back to the sign-in screen, keeping the requested page.
 *
 * When the browser still carries a session cookie the server no longer
 * recognizes — a session closed from "My account", expired, dropped with a second
 * factor reset —, we first go through `/logout`, which clears the cookie. Without
 * this detour, the proxy, which only sees the cookie's *presence*, would send
 * `/login` to `/`, then `/` to `/login`, endlessly.
 */
export async function redirectToLogin(pathname?: string): Promise<never> {
  const incoming = await headers();
  // Without an explicit path (a layout), the one the proxy passed on.
  const target = pathname ?? incoming.get('x-pupitre-path') ?? null;
  const query = target && target !== '/' ? `?next=${encodeURIComponent(target)}` : '';
  const stale = getSessionCookie(incoming) !== null;
  redirect(`${stale ? '/logout' : '/login'}${query}`);
}

/**
 * Where an account goes whose role requires a second factor it does not have
 * yet. Outside the `(app)` group, like the onboarding assistant: a redirect set by
 * the `(app)` layout toward a page it wraps would make the client router loop — it
 * would believe the layout already rendered and would not ask for it again.
 */
export const TWO_FACTOR_ENROLL_PATH = '/two-factor-setup';

/** The current context, or `null` if not authenticated. Does not redirect. */
export async function currentAuth(pathname = '/'): Promise<AuthContext | null> {
  try {
    return await requireSession(await requestFromHeaders(pathname));
  } catch {
    return null;
  }
}

/** Requires a session to show the page; redirects to `/login` otherwise. */
export async function requirePageSession(pathname: string): Promise<AuthContext> {
  try {
    return await requireSession(await requestFromHeaders(pathname));
  } catch (error) {
    if (error instanceof UnauthenticatedError) await redirectToLogin(pathname);
    throw error;
  }
}

/**
 * Requires one of these permissions to show the page: a screen that serves two
 * trades shows each one its part. Without any, the refusal is audited under the
 * first one's name, as for `requirePagePermission`.
 */
export async function requirePageAnyPermission(
  pathname: string,
  permissions: readonly [Permission, ...Permission[]],
): Promise<AuthContext> {
  const auth = await requirePageSession(pathname);
  if (permissions.some((permission) => auth.can(permission))) return auth;
  return requirePagePermission(pathname, permissions[0]);
}

/** Requires a permission to show the page. The refusal is audited. */
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
