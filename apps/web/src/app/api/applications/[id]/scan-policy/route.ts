import { applicationScanPolicySchema } from '@pupitre/core';
import {
  applicationScanPolicyOf,
  getApplication,
  logAudit,
  setApplicationScanPolicy,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { vulnerabilities as messages } from '@/i18n/messages/vulnerabilities';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

async function application(id: string) {
  const row = await getApplication(id);
  if (!row) throw new NotFoundError(msg(messages, 'error.applicationNotFound', { id }));
  return row;
}

/** The application's scan setting. `null`: like the instance. */
export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'scan:read');
  const { id } = paramsSchema.parse(await context.params);
  return NextResponse.json(applicationScanPolicyOf(await application(id)));
});

/**
 * Setting what blocks the application: its threshold, and whether it only holds
 * for fixable vulnerabilities. Both fields are required — `null` hands control
 * back to the instance. Holds for the next deployments.
 */
export const PUT = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'scan:configure');
  const { id } = paramsSchema.parse(await context.params);
  const policy = await readJsonBody(request, applicationScanPolicySchema);
  const app = await application(id);
  const before = applicationScanPolicyOf(app);
  await setApplicationScanPolicy(id, policy);
  await logAudit({
    actorId: auth.userId,
    action: 'application.scan_policy.changed',
    resourceType: 'application',
    resourceId: id,
    before: { application: app.slug, ...before },
    after: { application: app.slug, ...policy },
    ip: auth.ip,
  });
  return NextResponse.json(policy);
});
