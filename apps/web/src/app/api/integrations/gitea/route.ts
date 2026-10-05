import { tokenForgeRoutes } from '@/lib/token-forges';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The instance's Gitea / Forgejo forge: its address, its token's account.
 *
 * No route returns the token: it comes in, it is checked with the forge, it is
 * encrypted, it does not come out. The same routes as GitLab — see
 * `lib/token-forges.ts`.
 */
const routes = tokenForgeRoutes('gitea');

export const GET = routes.GET;
export const PUT = routes.PUT;
export const DELETE = routes.DELETE;
