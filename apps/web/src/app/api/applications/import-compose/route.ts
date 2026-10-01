import { importCompose, renderComposeIssue } from '@pupitre/core/compose';
import { getApplicationBySlug } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { currentLanguage } from '@/i18n/server';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Un docker-compose.yml raisonnable tient en quelques kilo-octets ; au-delà, c'est autre chose. */
const COMPOSE_MAX_BYTES = 256 * 1024;

const bodySchema = z.object({
  source: z.string().min(1).max(COMPOSE_MAX_BYTES),
  name: z.string().trim().max(48).optional(),
});

/**
 * Traduit un docker-compose.yml en AppSpec **proposée**. Rien n'est
 * enregistré ici : la spec revient à l'écran, avec la liste de ce qui n'a pas
 * pu passer tel quel, et c'est la création habituelle (`POST /api/applications`)
 * qui l'enregistre — validée, auditée, comme toutes les autres.
 *
 * Même permission que la création : convertir n'a de sens que pour créer.
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
