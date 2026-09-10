import { getSessionCookie } from 'better-auth/cookies';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * `proxy.ts` — l'ancien `middleware.ts`, renommé par Next 16.
 *
 * Il tourne en Edge : pas d'accès à la base, donc pas de vérification réelle
 * de session. Il ne fait qu'un filtrage optimiste sur la *présence* du cookie,
 * pour éviter un aller-retour inutile vers une page protégée. L'autorisation
 * véritable est faite par `requirePermission()` dans les Route Handlers et les
 * Server Components.
 */

const PUBLIC_PAGES = ['/login', '/signup'];

export default function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasSessionCookie = getSessionCookie(request) !== null;
  const isPublicPage = PUBLIC_PAGES.some(
    (page) => pathname === page || pathname.startsWith(`${page}/`),
  );

  if (!hasSessionCookie && !isPublicPage) {
    const login = new URL('/login', request.url);
    login.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(login);
  }

  if (hasSessionCookie && isPublicPage) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  return NextResponse.next();
}

export const config = {
  /**
   * Les routes d'API sont exclues : elles doivent répondre 401/403 en JSON,
   * jamais par une redirection HTML.
   */
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|ico)$).*)'],
};
