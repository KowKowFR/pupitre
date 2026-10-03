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

/**
 * Pages accessibles sans session.
 *
 * Les trois dernières sont celles du cycle de vie des comptes : par définition,
 * personne n'y arrive connecté — une invitation s'adresse à quelqu'un qui n'a
 * pas encore de mot de passe, et une réinitialisation à quelqu'un qui ne peut
 * plus entrer. Les oublier ici rendrait tout le parcours inatteignable, en
 * renvoyant sur `/login` la personne qui vient précisément de constater qu'elle
 * ne peut pas s'y connecter.
 */
const PUBLIC_PAGES = [
  // Les pages de statut : publiques par nature — c'est leur raison d'être.
  // Une page non publiée y répond 404, comme une adresse inconnue.
  '/status',
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/invitation',
];

/**
 * Pages qu'une session rend inutiles — et dont on renvoie donc au tableau de
 * bord. La distinction avec la liste ci-dessus n'est pas cosmétique : un lien
 * de réinitialisation doit s'ouvrir **même** dans un navigateur déjà connecté à
 * un autre compte, sinon le clic aboutit au tableau de bord de quelqu'un
 * d'autre et le lien semble cassé.
 */
const GUEST_ONLY_PAGES = ['/login', '/signup'];

function matches(pathname: string, pages: readonly string[]): boolean {
  return pages.some((page) => pathname === page || pathname.startsWith(`${page}/`));
}

/**
 * En-tête de requête posé par le proxy : le chemin et la requête d'origine.
 * Toujours réécrit ici — une valeur envoyée par le client ne passe pas.
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

  // Le chemin demandé, transmis aux layouts : ils ne le connaissent pas, et
  // c'est eux qui renvoient vers la connexion quand le cookie est périmé. Sans
  // lui, on reviendrait à la vue d'ensemble au lieu de la page demandée.
  const forwarded = new Headers(request.headers);
  forwarded.set(REQUESTED_PATH_HEADER, `${pathname}${search}`);
  return NextResponse.next({ request: { headers: forwarded } });
}

export const config = {
  /**
   * Les routes d'API sont exclues : elles doivent répondre 401/403 en JSON,
   * jamais par une redirection HTML.
   */
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|ico)$).*)'],
};
