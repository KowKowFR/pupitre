import { decideSourceProposal, getSourceProposal, logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sources as messages } from '@/i18n/messages/sources';
import { ConflictError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/** Ignorer un commit en attente : il ne partira pas. Le suivant sera examiné. */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'deployment:create');
  const { id } = paramsSchema.parse(await context.params);
  const existing = await getSourceProposal(id);
  if (!existing) throw new NotFoundError(msg(messages, 'error.proposalNotFound', { id }));

  const proposal = await decideSourceProposal(id, 'dismissed', auth.userId);
  if (!proposal) throw new ConflictError(msg(messages, 'error.proposalDecided'));

  await logAudit({
    actorId: auth.userId,
    action: 'source.commit.dismissed',
    resourceType: 'application_source',
    resourceId: proposal.sourceId,
    after: { sha: proposal.sha, reason: proposal.reason, proposalId: id },
    ip: auth.ip,
  });
  return NextResponse.json({ ok: true });
});
