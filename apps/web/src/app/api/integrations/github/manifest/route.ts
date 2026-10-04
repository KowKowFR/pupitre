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
  /** Absent: the App is created under the account of the person signed in to GitHub. */
  organization: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{1,39}$/)
    .nullable()
    .default(null),
});

/**
 * Prepares the App's creation: the manifest and the address where to post it.
 *
 * The browser posts the manifest to GitHub itself: the panel does not have to be
 * reachable. The `state` travels there and back and is compared to a cookie set
 * here — a return that does not come from this browser is refused.
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
