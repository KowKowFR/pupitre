import { encrypt } from '@tp/core';
import { createTarget, createTargetSchema, findConflictingTarget, listTargets, logAudit } from '@tp/db';
import { NextResponse } from 'next/server';
import { ConflictError } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { auditableTarget } from '@/lib/targets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'target:read');
  const items = await listTargets();
  return NextResponse.json({ items, total: items.length });
});

export const POST = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'target:create');
  const input = await readJsonBody(request, createTargetSchema);

  const conflict = await findConflictingTarget(input);
  if (conflict === 'name') {
    throw new ConflictError(`Une cible se nomme déjà « ${input.name} »`);
  }
  if (conflict === 'endpoint') {
    throw new ConflictError(
      `Une cible pointe déjà vers ${input.sshUser}@${input.host}:${input.port}`,
    );
  }

  // Le credential est chiffré ici et n'existe plus jamais en clair côté panel.
  const { credential, ...rest } = input;
  const target = await createTarget({ ...rest, encryptedCredential: encrypt(credential) });

  await logAudit({
    actorId: auth.userId,
    action: 'target.created',
    resourceType: 'target',
    resourceId: target.id,
    after: auditableTarget(target),
    ip: auth.ip,
  });

  return NextResponse.json(target, { status: 201 });
});
