import {
  ENV_NAME_PATTERN,
  catalogParamsSchema,
  findCatalogTemplate,
  instantiateCatalogTemplate,
} from '@pupitre/core';
import {
  createApplication,
  getApplicationBySlug,
  logAudit,
  secretValueSchema,
  setApplicationSecret,
  syncApplicationSecrets,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { catalog as messages } from '@/i18n/messages/catalog';
import { applications as appMessages } from '@/i18n/messages/applications';
import { currentLanguage } from '@/i18n/server';
import { assertNameFree } from '@/lib/application-name';
import { ConflictError, HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().min(1).max(64) });
type Context = { params: Promise<{ id: string }> };

const bodySchema = catalogParamsSchema.omit({ email: true }).extend({
  /** The passwords the template asks for, and only those. */
  secrets: z.record(z.string().regex(ENV_NAME_PATTERN), secretValueSchema).default({}),
});

/**
 * Installing a catalog template: it becomes an application like any other — an
 * AppSpec in the database, its secrets in the encrypted store.
 *
 * Nothing is deployed here: the installation stops where an application's
 * creation stops. Choosing the target and the runtime stays a separate gesture,
 * with its scans and its pipeline, as for the rest.
 */
export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'application:create');
  const { id } = paramsSchema.parse(await context.params);
  const input = await readJsonBody(request, bodySchema);

  const template = findCatalogTemplate(id);
  if (!template) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  for (const name of Object.keys(input.secrets)) {
    if (!template.askedSecrets.includes(name)) {
      throw new HttpError(422, 'secret_not_asked', msg(messages, 'error.secretNotAsked', { name }));
    }
  }
  for (const name of template.askedSecrets) {
    if (!input.secrets[name]?.trim()) {
      throw new HttpError(422, 'secret_missing', msg(messages, 'error.secretMissing', { name }));
    }
  }

  const appSpec = instantiateCatalogTemplate(template, {
    name: input.name,
    host: input.host,
    tls: input.tls,
    email: auth.email,
  });

  if (await getApplicationBySlug(appSpec.name)) {
    throw new ConflictError(msg(appMessages, 'error.slugTaken', { name: appSpec.name }));
  }
  await assertNameFree(appSpec.name);

  const language = await currentLanguage();
  const application = await createApplication({
    appSpec,
    description: `${template.name} — ${template.summary[language]}`.slice(0, 500),
    ownerId: auth.userId,
  });

  // First each secret's generated value, as for any creation; then those the
  // operator chose replace them. No value is logged: the log says which ones were
  // chosen, not what they are worth.
  await syncApplicationSecrets(application.id, appSpec);
  for (const name of template.askedSecrets) {
    await setApplicationSecret(application.id, name, input.secrets[name] ?? '', 'provided');
  }

  await logAudit({
    actorId: auth.userId,
    action: 'application.created',
    resourceType: 'application',
    resourceId: application.id,
    after: {
      slug: application.slug,
      version: appSpec.version,
      services: appSpec.services.map((service) => service.name),
      origin: 'catalog',
      template: template.id,
      host: input.host,
      providedSecrets: [...template.askedSecrets],
    },
    ip: auth.ip,
  });

  return NextResponse.json({ id: application.id, slug: application.slug }, { status: 201 });
});
