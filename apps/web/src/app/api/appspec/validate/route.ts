import { localizeZodError, safeParseAppSpec } from '@pupitre/core';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { currentLanguage } from '@/i18n/server';
import { applications as messages } from '@/i18n/messages/applications';
import { HttpError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requireCaller } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Validates an AppSpec without creating anything — the body **is** the AppSpec,
 * so a CI checks its `pupitre.json` with `curl --data @pupitre.json`.
 *
 * 200 with the AppSpec as Pupitre will store it, defaults applied. 422
 * `invalid_appspec` otherwise, with **every** problem and its full path
 * (`services.0.port`): the flattened form of the other routes keeps only the
 * first segment, which says "services" and nothing more.
 */
export const POST = apiRoute(async (request) => {
  await requireCaller(request);
  const input = await readJsonBody(request, z.unknown());
  const parsed = safeParseAppSpec(input);
  if (!parsed.success) {
    const localized = localizeZodError(parsed.error, await currentLanguage());
    throw new HttpError(422, 'invalid_appspec', msg(messages, 'error.appSpecInvalid'), {
      issues: localized.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    });
  }
  return NextResponse.json({ valid: true, appSpec: parsed.data });
});
