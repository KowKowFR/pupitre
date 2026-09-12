import { encrypt } from '@tp/core';
import {
  countDeploymentsOnTarget,
  deleteTarget,
  findConflictingTarget,
  getTarget,
  logAudit,
  updateTarget,
  updateTargetSchema,
} from '@tp/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ConflictError, NotFoundError } from '@/lib/errors';
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

  // `getTarget` ne sélectionne pas `encrypted_credential` :
  // la réponse ne peut structurellement pas le contenir.
  const target = await getTarget(id);
  if (!target) throw new NotFoundError(`Cible « ${id} » introuvable`);

  return NextResponse.json(target);
});

export const PATCH = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'target:update');
  const { id } = paramsSchema.parse(await context.params);
  const patch = await readJsonBody(request, updateTargetSchema);

  const before = await getTarget(id);
  if (!before) throw new NotFoundError(`Cible « ${id} » introuvable`);

  const conflict = await findConflictingTarget(
    {
      name: patch.name ?? before.name,
      host: patch.host ?? before.host,
      port: patch.port ?? before.port,
      sshUser: patch.sshUser ?? before.sshUser,
    },
    id,
  );
  if (conflict === 'name') throw new ConflictError('Ce nom de cible est déjà pris');
  if (conflict === 'endpoint') throw new ConflictError('Une autre cible pointe déjà vers cet hôte');

  // Le patch est partiel : les deux bornes ne sont pas forcément dans le corps.
  // On valide sur les valeurs résultantes, pas sur celles reçues — sinon
  // déplacer une seule borne pourrait inverser la plage sans qu'on le voie.
  const rangeStart = patch.portRangeStart ?? before.portRangeStart;
  const rangeEnd = patch.portRangeEnd ?? before.portRangeEnd;
  if (rangeStart > rangeEnd) {
    throw new ConflictError(
      `Plage de ports invalide : ${rangeStart}-${rangeEnd}. ` +
        'La borne basse doit précéder la borne haute.',
    );
  }

  const { credential, ...rest } = patch;
  const after = await updateTarget(id, {
    ...rest,
    // Credential absent du corps = on conserve celui déjà en base.
    ...(credential !== undefined ? { encryptedCredential: encrypt(credential) } : {}),
  });
  if (!after) throw new NotFoundError(`Cible « ${id} » introuvable`);

  await logAudit({
    actorId: auth.userId,
    action: 'target.updated',
    resourceType: 'target',
    resourceId: id,
    before: auditableTarget(before),
    // `credentialRotated` trace le fait, jamais la valeur.
    after: { ...auditableTarget(after), credentialRotated: credential !== undefined },
    ip: auth.ip,
  });

  return NextResponse.json(after);
});

export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'target:delete');
  const { id } = paramsSchema.parse(await context.params);

  const target = await getTarget(id);
  if (!target) throw new NotFoundError(`Cible « ${id} » introuvable`);

  // Deux refus, parce qu'il y a deux gestes à faire — et parce que la clé
  // étrangère est en `ON DELETE restrict` : un `failed` oublié bloque autant
  // qu'un déploiement qui tourne. Ne vérifier que le premier cas laissait la
  // contrainte trancher, et l'appelant recevait un 500 muet.
  const { live, history } = await countDeploymentsOnTarget(id);
  if (live > 0) {
    throw new ConflictError(
      `Cette cible porte ${live} déploiement(s) actif(s). Détruisez-les avant de la supprimer.`,
    );
  }
  if (history > 0) {
    throw new ConflictError(
      `Cette cible ne porte plus rien en marche, mais garde ${history} déploiement(s) ` +
        `dans l'historique, et l'historique ne se supprime pas tout seul. ` +
        `Purgez-les depuis l'écran Déploiements, puis reprenez.`,
    );
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
