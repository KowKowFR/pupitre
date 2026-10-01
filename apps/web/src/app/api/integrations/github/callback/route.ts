import { encrypt } from '@pupitre/core';
import { convertGitHubManifest, githubInstallUrl } from '@pupitre/core/sources';
import { logAudit, saveSourceConnection } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { requirePermission } from '@/lib/rbac';
import { GITHUB_STATE_COOKIE, panelOrigin } from '@/lib/sources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Le retour de GitHub après création de l'App : un code, échangé contre ses
 * identifiants — dont la clé privée, montrée une seule fois, chiffrée aussitôt.
 *
 * C'est une navigation du navigateur, pas un appel de GitHub : le panel n'a
 * jamais à être joignable. Réussi, on enchaîne sur l'installation (choix des
 * dépôts) ; raté, on revient aux Paramètres avec l'erreur, jamais sur une page
 * JSON.
 */
export async function GET(request: Request): Promise<Response> {
  const origin = panelOrigin();
  const back = (error: string) =>
    NextResponse.redirect(
      `${origin}/admin/settings/integrations?error=${encodeURIComponent(error)}`,
    );

  let auth;
  try {
    auth = await requirePermission(request, 'settings:manage');
  } catch {
    return NextResponse.redirect(`${origin}/admin/settings/integrations`);
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expected = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${GITHUB_STATE_COOKIE}=`))
    ?.slice(GITHUB_STATE_COOKIE.length + 1);
  if (!code || !state || !expected || state !== expected) return back('state');

  try {
    const app = await convertGitHubManifest(code);
    const connection = await saveSourceConnection({
      provider: 'github',
      appId: app.appId,
      slug: app.slug,
      name: app.name,
      htmlUrl: app.htmlUrl,
      owner: app.owner,
      apiUrl: null,
      privateKeyEncrypted: encrypt(app.privateKey),
      createdBy: auth.userId,
    });
    await logAudit({
      actorId: auth.userId,
      action: 'integration.github.connected',
      resourceType: 'source_connection',
      resourceId: connection.id,
      after: { appId: app.appId, slug: app.slug, owner: app.owner, via: 'manifest' },
      ip: auth.ip,
    });
    const response = NextResponse.redirect(githubInstallUrl(app.slug));
    response.cookies.delete({ name: GITHUB_STATE_COOKIE, path: '/api/integrations/github' });
    return response;
  } catch (error) {
    logger.warn({ err: error }, "création de l'application GitHub impossible");
    return back('github');
  }
}
