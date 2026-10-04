import { getSessionCookie } from 'better-auth/cookies';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * `proxy.ts` — the former `middleware.ts`, renamed by Next 16.
 *
 * It runs on Edge: no access to the database, hence no real session check. It
 * only does an optimistic filtering on the cookie's *presence*, to avoid a
 * useless round trip to a protected page. The real authorization is done by
 * `requirePermission()` in the Route Handlers and Server Components.
 */

/**
 * Pages reachable without a session.
 *
 * The last three are those of the accounts' life cycle: by definition, nobody
 * arrives there signed in — an invitation is addressed to someone who has no
 * password yet, and a reset to someone who can no longer get in. Forgetting them
 * here would make the whole journey unreachable, by sending to `/login` the very
 * person who just found out they cannot sign in there.
 */
const PUBLIC_PAGES = [
  // The status pages: public by nature — it is their reason for being. An
  // unpublished page answers 404 there, like an unknown address.
  '/status',
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/invitation',
];

/**
 * Pages a session makes useless — and from which one is therefore sent to the
 * dashboard. The distinction with the list above is not cosmetic: a reset link
 * must open **even** in a browser already signed in to another account, otherwise
 * the click ends up on someone else's dashboard and the link looks broken.
 */
const GUEST_ONLY_PAGES = ['/login', '/signup'];

function matches(pathname: string, pages: readonly string[]): boolean {
  return pages.some((page) => pathname === page || pathname.startsWith(`${page}/`));
}

/**
 * A request header set by the proxy: the original path and query. Always
 * rewritten here — a value sent by the client does not go through.
 */
const REQUESTED_PATH_HEADER = 'x-pupitre-path';

export default function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasSessionCookie = getSessionCookie(request) !== null;

  if (!hasSessionCookie && !matches(pathname, PUBLIC_PAGES)) {
    const login = new URL('/login', request.url);
    login.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(login);
  }

  if (hasSessionCookie && matches(pathname, GUEST_ONLY_PAGES)) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  // The requested path, passed on to the layouts: they do not know it, and it is
  // they that send to sign-in when the cookie is stale. Without it, one would come
  // back to the overview instead of the requested page.
  const forwarded = new Headers(request.headers);
  forwarded.set(REQUESTED_PATH_HEADER, `${pathname}${search}`);
  return NextResponse.next({ request: { headers: forwarded } });
}

export const config = {
  /**
   * The API routes are excluded: they must answer 401/403 as JSON, never with an
   * HTML redirect.
   */
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|ico)$).*)'],
};
