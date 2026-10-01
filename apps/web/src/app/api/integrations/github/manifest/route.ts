import { randomBytes } from 'node:crypto';
import { githubAppManifest, githubManifestUrl } from '@pupitre/core/sources';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { GITHUB_STATE_COOKIE, panelOrigin } from '@/lib/sources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  name: z.string().trim().min(1).max(34),
  /** Absente : l'App est créée sous le compte de la personne connectée à GitHub. */
  organization: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{1,39}$/)
    .nullable()
    .default(null),
});

/**
 * Prépare la création de l'App : le manifeste et l'adresse où le poster.
 *
 * Le navigateur poste lui-même le manifeste à GitHub : le panel n'a pas à être
 * joignable. Le `state` voyage aller-retour et se compare à un cookie posé
 * ici — un retour qui ne vient pas de ce navigateur est refusé.
 */
export const POST = apiRoute(async (request) => {
  await requirePermission(request, 'settings:manage');
  const body = await readJsonBody(request, bodySchema);
  const origin = panelOrigin();
  const state = randomBytes(24).toString('base64url');

  const response = NextResponse.json({
    action: githubManifestUrl(body.organization, state),
    manifest: JSON.stringify(
      githubAppManifest({
        name: body.name,
        panelUrl: origin,
        redirectUrl: `${origin}/api/integrations/github/callback`,
        setupUrl: `${origin}/admin/settings/integrations`,
      }),
    ),
  });
  response.cookies.set(GITHUB_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: origin.startsWith('https:'),
    path: '/api/integrations/github',
    maxAge: 600,
  });
  return response;
});
