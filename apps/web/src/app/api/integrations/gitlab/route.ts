import { tokenForgeRoutes } from '@/lib/token-forges';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * L'instance GitLab de l'instance Pupitre — gitlab.com ou une auto-hébergée :
 * son adresse, le compte de son jeton (souvent le robot d'un jeton de projet
 * ou de groupe).
 *
 * Aucune route ne rend le jeton : il entre, il est vérifié auprès de GitLab
 * — portée `api` exigée —, il est chiffré, il ne ressort pas. Les mêmes
 * routes que Gitea — voir `lib/token-forges.ts`.
 */
const routes = tokenForgeRoutes('gitlab');

export const GET = routes.GET;
export const PUT = routes.PUT;
export const DELETE = routes.DELETE;
