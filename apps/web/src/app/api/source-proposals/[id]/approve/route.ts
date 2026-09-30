import { decideSourceProposal, getSourceProposal, logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sources as messages } from '@/i18n/messages/sources';
import { ConflictError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { enqueueSourceDeploy } from '@/lib/source-routes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * Valider un commit en attente : il part, exactement tel qu'il a été montré —
 * l'AppSpec gardée au moment de la proposition, pas une relecture du dépôt.
 * Seule une proposition encore en attente se valide : deux clics ne
 * déploient pas deux fois.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'deployment:create');
  const { id } = paramsSchema.parse(await context.params);
  const existing = await getSourceProposal(id);
  if (!existing) throw new NotFoundError(msg(messages, 'error.proposalNotFound', { id }));

  const proposal = await decideSourceProposal(id, 'approved', auth.userId);
  if (!proposal) throw new ConflictError(msg(messages, 'error.proposalDecided'));

  const jobId = await enqueueSourceDeploy({
    kind: 'proposal',
    proposalId: id,
    actorId: auth.userId,
    ip: auth.ip,
  });
  await logAudit({
    actorId: auth.userId,
    action: 'source.commit.approved',
    resourceType: 'application_source',
    resourceId: proposal.sourceId,
    after: { sha: proposal.sha, reason: proposal.reason, proposalId: id, jobId },
    ip: auth.ip,
  });
  return NextResponse.json({ jobId }, { status: 202 });
});
