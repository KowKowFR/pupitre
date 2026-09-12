import { secretBindings, secretRootName } from '@pupitre/core';
import {
  declaredSecretsOf,
  deleteApplicationSecret,
  getApplication,
  logAudit,
  rotateApplicationSecret,
  secretNameSchema,
  secretValueSchema,
  setApplicationSecret,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ConflictError, NotFoundError } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid(), name: secretNameSchema });
type Context = { params: Promise<{ id: string; name: string }> };

/**
 * Deux gestes, un seul verbe.
 *
 * `{ "value": "..." }` pose une valeur venue de l'extérieur — une clé d'API
 * qu'aucun tirage au sort ne peut deviner. Elle devient `provided`.
 * `{ "generate": true }` en tire une nouvelle, forte, que personne ne lira
 * jamais : c'est le geste de rotation, et c'est aussi le défaut à la création.
 *
 * Aucune réponse, ici ou ailleurs, ne porte la valeur. Poser un secret et le
 * relire sont deux droits différents, et le second n'existe pas.
 */
const bodySchema = z.union([
  z.object({ value: secretValueSchema }),
  z.object({ generate: z.literal(true) }),
]);

export const PUT = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'application:update');
  const { id, name } = paramsSchema.parse(await context.params);
  const body = await readJsonBody(request, bodySchema);

  const application = await getApplication(id);
  if (!application) throw new NotFoundError(`Application « ${id} » introuvable`);

  // Un alias n'a pas de valeur à lui : lui en poser une créerait la seconde
  // ligne que `from` existe pour éviter, et les deux services repartiraient
  // avec deux mots de passe différents. On renvoie vers celui qui la porte.
  const root = secretRootName(secretBindings(application.appSpec), name);
  if (root !== name) {
    throw new ConflictError(
      `« ${name} » reprend la valeur de « ${root} » : il n'a pas de valeur propre. ` +
        `Modifiez « ${root} », les deux noms suivront.`,
    );
  }

  const secret =
    'generate' in body
      ? await rotateApplicationSecret(id, name)
      : await setApplicationSecret(id, name, body.value, 'provided');

  await logAudit({
    actorId: auth.userId,
    action: 'application.secret.set',
    resourceType: 'application',
    resourceId: id,
    // Le nom et la provenance, jamais la valeur ni sa longueur : le journal
    // d'audit est lisible par quiconque a `audit:read`.
    after: { slug: application.slug, secret: name, origin: secret.origin },
    ip: auth.ip,
  });

  return NextResponse.json({
    name: secret.name,
    origin: secret.origin,
    isSet: true,
    updatedAt: secret.updatedAt.toISOString(),
  });
});

/**
 * Supprime un secret.
 *
 * Refusé tant que l'AppSpec courante le déclare : la valeur détruite ne revient
 * pas, et le prochain déploiement échouerait au rendu. Retirer le nom de la spec
 * d'abord, supprimer la valeur ensuite — dans cet ordre, jamais l'inverse.
 */
export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'application:update');
  const { id, name } = paramsSchema.parse(await context.params);

  const application = await getApplication(id);
  if (!application) throw new NotFoundError(`Application « ${id} » introuvable`);

  if (declaredSecretsOf(application.appSpec).includes(name)) {
    throw new ConflictError(
      `« ${name} » est déclaré par l'AppSpec courante : retirez-le de la spec avant ` +
        'de supprimer sa valeur.',
    );
  }

  const removed = await deleteApplicationSecret(id, name);
  if (!removed) throw new NotFoundError(`Secret « ${name} » introuvable`);

  await logAudit({
    actorId: auth.userId,
    action: 'application.secret.deleted',
    resourceType: 'application',
    resourceId: id,
    before: { slug: application.slug, secret: name },
    ip: auth.ip,
  });

  return NextResponse.json({ name, deleted: true });
});
