import { tokenForgeRoutes } from '@/lib/token-forges';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * La forge Gitea / Forgejo de l'instance : son adresse, le compte de son jeton.
 *
 * Aucune route ne rend le jeton : il entre, il est vérifié auprès de la forge,
 * il est chiffré, il ne ressort pas. Les mêmes routes que GitLab — voir
 * `lib/token-forges.ts`.
 */
const routes = tokenForgeRoutes('gitea');

export const GET = routes.GET;
export const PUT = routes.PUT;
export const DELETE = routes.DELETE;
