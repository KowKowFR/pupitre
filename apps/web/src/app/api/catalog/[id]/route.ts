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
import { ConflictError, HttpError, NotFoundError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().min(1).max(64) });
type Context = { params: Promise<{ id: string }> };

const bodySchema = catalogParamsSchema.omit({ email: true }).extend({
  /** Les mots de passe que le modèle demande, et eux seuls. */
  secrets: z.record(z.string().regex(ENV_NAME_PATTERN), secretValueSchema).default({}),
});

/**
 * Installer un modèle du catalogue : il devient une application comme une
 * autre — une AppSpec en base, ses secrets dans le magasin chiffré.
 *
 * Rien ne se déploie ici : l'installation s'arrête où s'arrête la création
 * d'une application. Le choix de la cible et du runtime reste un geste à
 * part, avec ses scans et son pipeline, comme pour le reste.
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

  const language = await currentLanguage();
  const application = await createApplication({
    appSpec,
    description: `${template.name} — ${template.summary[language]}`.slice(0, 500),
    ownerId: auth.userId,
  });

  // D'abord la valeur générée de chaque secret, comme pour toute création ;
  // puis ceux que l'opérateur a choisis la remplacent. Aucune valeur n'est
  // journalisée : le journal dit lesquels ont été choisis, pas ce qu'ils valent.
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
