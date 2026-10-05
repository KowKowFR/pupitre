import { encrypt } from '@pupitre/core';
import {
  countDeploymentsOnTarget,
  deleteTarget,
  findConflictingTarget,
  getTarget,
  logAudit,
  updateTarget,
  updateTargetSchema,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { targets as messages } from '@/i18n/messages/targets';
import { ConflictError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { auditableTarget } from '@/lib/targets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

type Context = { params: Promise<{ id: string }> };

export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'target:read');
  const { id } = paramsSchema.parse(await context.params);

  // `getTarget` does not select `encrypted_credential`: the response structurally
  // cannot contain it.
  const target = await getTarget(id);
  if (!target) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  return NextResponse.json(target);
});

export const PATCH = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'target:update');
  const { id } = paramsSchema.parse(await context.params);
  const patch = await readJsonBody(request, updateTargetSchema);

  const before = await getTarget(id);
  if (!before) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  const conflict = await findConflictingTarget(
    {
      name: patch.name ?? before.name,
      host: patch.host ?? before.host,
      port: patch.port ?? before.port,
      sshUser: patch.sshUser ?? before.sshUser,
    },
    id,
  );
  if (conflict === 'name') throw new ConflictError(msg(messages, 'error.nameTakenShort'));
  if (conflict === 'endpoint') {
    throw new ConflictError(msg(messages, 'error.endpointTakenOther'));
  }

  // The patch is partial: both bounds are not necessarily in the body. We validate
  // on the resulting values, not on those received — otherwise moving a single
  // bound could invert the range without anyone seeing it.
  const rangeStart = patch.portRangeStart ?? before.portRangeStart;
  const rangeEnd = patch.portRangeEnd ?? before.portRangeEnd;
  if (rangeStart > rangeEnd) {
    throw new ConflictError(
      msg(messages, 'error.badRange', { start: rangeStart, end: rangeEnd }),
    );
  }

  const { credential, ...rest } = patch;
  const after = await updateTarget(id, {
    ...rest,
    // Credential absent from the body = we keep the one already in the database.
    ...(credential !== undefined ? { encryptedCredential: encrypt(credential) } : {}),
  });
  if (!after) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  await logAudit({
    actorId: auth.userId,
    action: 'target.updated',
    resourceType: 'target',
    resourceId: id,
    before: auditableTarget(before),
    // `credentialRotated` traces the fact, never the value.
    after: { ...auditableTarget(after), credentialRotated: credential !== undefined },
    ip: auth.ip,
  });

  return NextResponse.json(after);
});

export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'target:delete');
  const { id } = paramsSchema.parse(await context.params);

  const target = await getTarget(id);
  if (!target) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  // Two refusals, because there are two gestures to make — and because the foreign
  // key is `ON DELETE restrict`: a forgotten `failed` blocks as much as a running
  // deployment. Only checking the first case left the constraint to decide, and the
  // caller received a mute 500.
  const { live, history } = await countDeploymentsOnTarget(id);
  if (live > 0) {
    throw new ConflictError(msg(messages, 'error.liveDeployments', { count: live }));
  }
  if (history > 0) {
    throw new ConflictError(msg(messages, 'error.pastDeployments', { count: history }));
  }

  await deleteTarget(id);

  await logAudit({
    actorId: auth.userId,
    action: 'target.deleted',
    resourceType: 'target',
    resourceId: id,
    before: auditableTarget(target),
    ip: auth.ip,
  });

  return NextResponse.json({ id, deleted: true });
});
