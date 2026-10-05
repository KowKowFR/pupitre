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
import { applications as messages } from '@/i18n/messages/applications';
import { ConflictError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid(), name: secretNameSchema });
type Context = { params: Promise<{ id: string; name: string }> };

/**
 * Two gestures, a single verb.
 *
 * `{ "value": "..." }` sets a value coming from outside — an API key no random
 * draw can guess. It becomes `provided`. `{ "generate": true }` draws a new,
 * strong one that nobody will ever read: it is the rotation gesture, and it is
 * also the default at creation.
 *
 * No response, here or elsewhere, carries the value. Setting a secret and reading
 * it back are two different rights, and the second does not exist.
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
  if (!application) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  // An alias has no value of its own: setting one on it would create the second
  // row `from` exists to avoid, and the two services would start again with two
  // different passwords. We refer to the one that carries it.
  const root = secretRootName(secretBindings(application.appSpec), name);
  if (root !== name) {
    throw new ConflictError(msg(messages, 'error.secretAlias', { name, root }));
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
    // The name and the provenance, never the value nor its length: the audit log is
    // readable by whoever has `audit:read`.
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
 * Deletes a secret.
 *
 * Refused as long as the current AppSpec declares it: the destroyed value does
 * not come back, and the next deployment would fail at rendering. Remove the
 * name from the spec first, delete the value next — in that order, never the
 * reverse.
 */
export const DELETE = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'application:update');
  const { id, name } = paramsSchema.parse(await context.params);

  const application = await getApplication(id);
  if (!application) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  if (declaredSecretsOf(application.appSpec).includes(name)) {
    throw new ConflictError(msg(messages, 'error.secretDeclared', { name }));
  }

  const removed = await deleteApplicationSecret(id, name);
  if (!removed) throw new NotFoundError(msg(messages, 'error.secretNotFound', { name }));

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
