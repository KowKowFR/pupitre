import {
  SOURCE_PROVIDER_KINDS,
  parseSourceSpec,
  safeParseAppSpec,
  sourceRepositorySchema,
} from '@pupitre/core';
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
import { currentLanguage, getT } from '@/i18n/server';
import { createApplicationFromSpec } from '@/lib/application-create';
import { HttpError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';
import { accessibleRepository, connectedProvider, sourceJson } from '@/lib/source-routes';
import { providerError } from '@/lib/sources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  /** The repository's provider; GitHub when nothing is said. */
  provider: z.enum(SOURCE_PROVIDER_KINDS).default('github'),
  repository: sourceRepositorySchema,
  /** GitHub : l'installation de l'App. Rien chez Gitea ni GitLab. */
  installationId: z.number().int().positive().nullable().default(null),
  branch: z.string().trim().min(1).max(255),
  specPath: repoPathSchema,
  /**
   * At each new commit: `none` — the application takes the version, one deploys it
   * wherever one wants; `running` — it is redeployed where it runs.
   */
  deployTo: z.enum(['none', 'running']).default('none'),
  /** With `running`: does an infrastructure change wait for approval? */
  mode: sourceModeSchema.default('auto_unless_infra'),
  description: z.string().max(500).optional(),
  /** Read and validate without creating anything — the form's preview. */
  preview: z.boolean().default(false),
});

/**
 * Creating an application **from its repository**: a branch's `pupitre.json`
 * becomes the application, linked to that branch, without an imposed target — it
 * is then deployed wherever one wants, like any other. The following commits
 * update it, or redeploy it where it runs.
 *
 * With `preview`, nothing is created: the file is read at the head commit and
 * validated, so that the form shows what will be created — or what is wrong.
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

  // The application's name is the file's: we read it first, then the whole file is
  // validated as a commit would be (`parseSourceSpec`).
  let name: string | null = null;
  try {
    const raw = safeParseAppSpec(JSON.parse(content));
    name = raw.success ? raw.data.name : null;
  } catch {
    name = null;
  }
  const read = parseSourceSpec(content, name ?? '', await currentLanguage());
  const taken = read.ok ? (await getApplicationBySlug(read.spec.name)) !== null : false;

  if (input.preview) {
    // The preview is a response, not an error: the sentence is translated here.
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
      // The application carries this commit's AppSpec: it is the version to deploy,
      // and the starting point of the follow-up.
      syncedSha: head.sha,
    });
  } catch (error) {
    // An application without its link would not be what was asked for.
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
