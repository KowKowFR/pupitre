import { importCompose, renderComposeIssue } from '@pupitre/core/compose';
import { getApplicationBySlug } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { currentLanguage } from '@/i18n/server';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A reasonable docker-compose.yml fits in a few kilobytes; beyond that, it is something else. */
const COMPOSE_MAX_BYTES = 256 * 1024;

const bodySchema = z.object({
  source: z.string().min(1).max(COMPOSE_MAX_BYTES),
  name: z.string().trim().max(48).optional(),
});

/**
 * Translates a docker-compose.yml into a **proposed** AppSpec. Nothing is saved
 * here: the spec comes back to the screen, with the list of what could not go
 * through as is, and it is the usual creation (`POST /api/applications`) that
 * saves it — validated, audited, like all the others.
 *
 * The same permission as creation: converting only makes sense to create.
 */
export const POST = apiRoute(async (request) => {
  await requirePermission(request, 'application:create');
  const input = await readJsonBody(request, bodySchema);
  const language = await currentLanguage();

  const result = importCompose(input.source, { name: input.name ?? null });
  const slugTaken = result.spec !== null && (await getApplicationBySlug(result.spec.name)) !== null;

  return NextResponse.json({
    spec: result.spec,
    valid: result.valid,
    slugTaken,
    issues: result.issues.map((issue) => ({
      level: issue.level,
      code: issue.code,
      service: issue.service,
      message: renderComposeIssue(issue, language),
    })),
  });
});
