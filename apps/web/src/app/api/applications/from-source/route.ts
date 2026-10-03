import { SOURCE_PROVIDER_KINDS, parseSourceSpec, safeParseAppSpec } from '@pupitre/core';
import {
  createApplicationSource,
  deleteApplication,
  getApplicationBySlug,
  logAudit,
  repoPathSchema,
  sourceModeSchema,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sources as messages } from '@/i18n/messages/sources';
import { getT } from '@/i18n/server';
import { createApplicationFromSpec } from '@/lib/application-create';
import { HttpError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { accessibleRepository, connectedProvider, sourceJson } from '@/lib/source-routes';
import { providerError } from '@/lib/sources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  /** Le fournisseur du dépôt ; GitHub quand rien n'est dit. */
  provider: z.enum(SOURCE_PROVIDER_KINDS).default('github'),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  /** GitHub : l'installation de l'App. Rien chez Gitea. */
  installationId: z.number().int().positive().nullable().default(null),
  branch: z.string().trim().min(1).max(255),
  specPath: repoPathSchema,
  /**
   * À chaque nouveau commit : `none` — l'application prend la version, on la
   * déploie où l'on veut ; `running` — elle est redéployée là où elle tourne.
   */
  deployTo: z.enum(['none', 'running']).default('none'),
  /** Avec `running` : un changement d'infrastructure attend-il une validation ? */
  mode: sourceModeSchema.default('auto_unless_infra'),
  description: z.string().max(500).optional(),
  /** Lire et valider sans rien créer — l'aperçu du formulaire. */
  preview: z.boolean().default(false),
});

/**
 * Créer une application **depuis son dépôt** : le `pupitre.json` d'une branche
 * devient l'application, liée à cette branche, sans cible imposée — on la
 * déploie ensuite où l'on veut, comme n'importe quelle autre. Les commits
 * suivants la mettent à jour, ou la redéploient là où elle tourne.
 *
 * Avec `preview`, rien n'est créé : le fichier est lu au commit en tête et
 * validé, pour que le formulaire montre ce qui sera créé — ou ce qui ne va pas.
 */
export const POST = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'application:create');
  const input = await readJsonBody(request, bodySchema);

  const access = await connectedProvider(input.provider);
  const connection = access.connection;

  const repo = await accessibleRepository(access.provider, input.repository, input.installationId);
  const ref = { fullName: repo.fullName, installationId: repo.installationId };
  const head = await access.provider.resolveHead(ref, input.branch, null).catch(providerError);
  if (!head.changed) {
    throw new HttpError(
      404,
      'branch_not_found',
      msg(messages, 'error.branchNotFound', { branch: input.branch }),
    );
  }
  const content = await access.provider
    .readFile(ref, head.sha, input.specPath)
    .catch(providerError);
  if (content === null) {
    throw new HttpError(
      422,
      'spec_missing',
      msg(messages, 'error.specMissing', { path: input.specPath, branch: input.branch }),
    );
  }

  // Le nom de l'application est celui du fichier : on le lit d'abord, puis le
  // fichier entier est validé comme le serait un commit (`parseSourceSpec`).
  let name: string | null = null;
  try {
    const raw = safeParseAppSpec(JSON.parse(content));
    name = raw.success ? raw.data.name : null;
  } catch {
    name = null;
  }
  const read = parseSourceSpec(content, name ?? '');
  const taken = read.ok ? (await getApplicationBySlug(read.spec.name)) !== null : false;

  if (input.preview) {
    // L'aperçu est une réponse, pas une erreur : la phrase est traduite ici.
    const t = await getT(messages);
    return NextResponse.json({
      sha: head.sha,
      ok: read.ok && !taken,
      issues: read.ok
        ? taken
          ? [t('error.slugTaken', { name: read.spec.name })]
          : []
        : read.issues,
      spec: read.ok
        ? {
            name: read.spec.name,
            version: read.spec.version,
            services: read.spec.services.map((service) => ({
              name: service.name,
              source:
                service.source.type === 'image'
                  ? service.source.ref
                  : `Dockerfile (${service.source.context})`,
              port: service.port,
              exposed: service.exposed,
            })),
            host: read.spec.ingress?.host ?? null,
          }
        : null,
    });
  }

  if (!read.ok) {
    throw new HttpError(
      422,
      'spec_invalid',
      msg(messages, 'error.specInvalid', { path: input.specPath, issue: read.issues[0] ?? '' }),
    );
  }

  const application = await createApplicationFromSpec({
    appSpec: read.spec,
    ...(input.description !== undefined ? { description: input.description } : {}),
    origin: 'repository',
    originDetail: {
      repository: repo.fullName,
      branch: input.branch,
      specPath: input.specPath,
      sha: head.sha,
    },
    secrets: {},
    actorId: auth.userId,
    ip: auth.ip,
  });

  let source;
  try {
    source = await createApplicationSource({
      provider: input.provider,
      repository: repo.fullName,
      installationId: repo.installationId,
      branch: input.branch,
      specPath: input.specPath,
      watchPaths: [],
      mode: input.mode,
      deployTo: input.deployTo,
      enabled: true,
      targets: [],
      applicationId: application.id,
      connectionId: connection.id,
      createdBy: auth.userId,
      // L'application porte l'AppSpec de ce commit : il est la version à
      // déployer, et le point de départ du suivi.
      syncedSha: head.sha,
    });
  } catch (error) {
    // Une application sans sa liaison ne serait pas ce qu'on a demandé.
    await deleteApplication(application.id);
    throw error;
  }

  await logAudit({
    actorId: auth.userId,
    action: 'source.linked',
    resourceType: 'application_source',
    resourceId: source.id,
    after: {
      applicationSlug: application.slug,
      provider: input.provider,
      repository: source.repository,
      branch: source.branch,
      specPath: source.specPath,
      mode: source.mode,
      deployTo: source.deployTo,
      sha: head.sha,
    },
    ip: auth.ip,
  });

  return NextResponse.json({ application, source: sourceJson(source) }, { status: 201 });
});
