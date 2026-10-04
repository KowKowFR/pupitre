import { tokenForgeRoutes } from '@/lib/token-forges';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The Pupitre instance's GitLab instance — gitlab.com or a self-hosted one: its
 * address, its token's account (often the bot of a project or group token).
 *
 * No route returns the token: it comes in, it is checked with GitLab — `api`
 * scope required —, it is encrypted, it does not come out. The same routes as
 * Gitea — see `lib/token-forges.ts`.
 */
const routes = tokenForgeRoutes('gitlab');

export const GET = routes.GET;
export const PUT = routes.PUT;
export const DELETE = routes.DELETE;
