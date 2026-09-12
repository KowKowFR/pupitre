import {
  APPLICATION_DELETE_JOB,
  applicationDeleteJobDataSchema,
  workspaceNameFor,
  type Permission,
} from '@pupitre/core';
import {
  countDeploymentsFor,
  getApplication,
  listApplicationDeletionBlockers,
  listApplicationPortAllocations,
  logAudit,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ConflictError, HttpError, NotFoundError } from '@/lib/errors';
import { apiRoute, readJsonBody, readSearchParams } from '@/lib/http';
import { getOpsQueue } from '@/lib/queue';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
type Context = { params: Promise<{ id: string }> };

/**
 * Suppression en cascade d'une application, et sa porte de secours.
 *
 * Route à part de `DELETE /api/applications/:id`, qui reste le geste simple :
 * effacer une application qui ne retient plus rien. Ici c'est l'inverse — on
 * part du principe qu'elle tourne, et on va la démonter sur ses cibles avant de
 * l'effacer. Deux gestes, deux chemins, deux jeux de permissions.
 *
 * ── Les permissions exigées ───────────────────────────────────────────────────
 * L'opération fait trois choses, elle exige donc les trois permissions
 * correspondantes : `deployment:destroy` (elle démonte sur la machine),
 * `deployment:purge` (elle efface l'historique) et `application:delete` (elle
 * supprime l'application). Leur **union**, pas une permission de plus : qui sait
 * faire les trois séparément sait les enchaîner, et inventer un quatrième mot
 * aurait créé un pouvoir que personne n'a encore dans aucun rôle.
 *
 * Le forçage exige exactement les mêmes, et pas davantage — le vocabulaire RBAC
 * n'a rien de plus strict à offrir. Ce qu'il exige en plus n'est pas une
 * permission mais une **intention** : le slug de l'application, retapé à la
 * main, après avoir vu la liste de ce qu'on abandonne. Une case à cocher se
 * coche par réflexe ; un nom se recopie en regardant.
 */
const CASCADE_PERMISSIONS = [
  'deployment:destroy',
  'deployment:purge',
  'application:delete',
] as const satisfies readonly Permission[];

async function requireCascadePermissions(request: Request) {
  let auth = await requirePermission(request, CASCADE_PERMISSIONS[0]);
  for (const permission of CASCADE_PERMISSIONS.slice(1)) {
    auth = await requirePermission(request, permission);
  }
  return auth;
}

/**
 * Ce qu'un forçage abandonnerait, **nommé**.
 *
 * Le nom du regroupement vient de la convention partagée (`workspaceNameFor`)
 * et non d'un driver : `@pupitre/core/drivers` est hors du graphe du panel. Le
 * journal d'activité, lui, est écrit par le worker, qui interroge le driver —
 * c'est là qu'est l'autorité.
 */
function describe(
  blockers: Awaited<ReturnType<typeof listApplicationDeletionBlockers>>,
  slug: string,
) {
  return blockers.map((blocker) => ({
    deploymentId: blocker.id,
    version: blocker.version,
    status: blocker.status,
    runtime: blocker.runtime,
    reason: blocker.reason,
    message: blocker.message,
    targetId: blocker.targetId,
    targetName: blocker.targetName,
    targetHost: blocker.targetHost,
    workspace: workspaceNameFor(slug),
    publishedPort: blocker.publishedPort,
  }));
}

const querySchema = z.object({
  /**
   * Suit une cascade déjà lancée. Sur cette route et non sur
   * `/api/queue/jobs/:id`, qui exige `job:read` : quelqu'un qui a le droit de
   * lancer une suppression doit pouvoir en lire l'issue sans qu'on lui accorde
   * la lecture de toute la file. Et l'application, elle, a pu disparaître
   * entre-temps — c'est même le cas nominal.
   */
  jobId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
});

/**
 * Prévisualisation. Elle n'écrit rien et sert la modale de confirmation : elle
 * doit **nommer** — quelle cible, quel projet Compose, quel port —, pas
 * compter. Un décompte ne permet à personne d'aller finir le ménage à la main.
 *
 * Avec `?jobId=`, elle rend l'état d'une cascade en cours à la place.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'application:delete');
  const { id } = paramsSchema.parse(await context.params);
  const { jobId } = readSearchParams(request, querySchema);

  if (jobId !== undefined) {
    const job = await getOpsQueue().getJob(jobId);
    if (!job) throw new NotFoundError(`Aucune tâche « ${jobId} » dans la queue ops`);

    // Une tâche d'une autre application n'a rien à répondre sur ce chemin.
    const data = applicationDeleteJobDataSchema.safeParse(job.data);
    if (!data.success || data.data.applicationId !== id) {
      throw new NotFoundError(`La tâche « ${jobId} » ne concerne pas cette application`);
    }

    return NextResponse.json({
      jobId: job.id,
      state: await job.getState(),
      finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
      result: job.returnvalue ?? null,
      failedReason: job.failedReason ?? null,
    });
  }

  const application = await getApplication(id);
  if (!application) throw new NotFoundError(`Application « ${id} » introuvable`);

  const [blockers, reservedPorts, historyCount] = await Promise.all([
    listApplicationDeletionBlockers(id),
    listApplicationPortAllocations(id),
    countDeploymentsFor(id),
  ]);

  const missing = CASCADE_PERMISSIONS.filter((permission) => !auth.can(permission));

  return NextResponse.json({
    applicationId: id,
    applicationSlug: application.slug,
    workspace: workspaceNameFor(application.slug),
    /** Vide ⇒ `DELETE /api/applications/:id` suffit, sans cascade ni forçage. */
    blockers: describe(blockers, application.slug),
    /** Déploiements qui partiront de l'historique, `destroyed` compris. */
    historyCount,
    reservedPorts,
    requiredPermissions: CASCADE_PERMISSIONS,
    missingPermissions: missing,
    canCascade: missing.length === 0,
  });
});

const cascadeSchema = z.object({
  /**
   * `false` : on détruit, et si une cible résiste on n'efface rien.
   * `true`  : on détruit quand même d'abord, et ce qui résiste est abandonné —
   *           nommé dans le journal d'activité, puis effacé de la base.
   */
  force: z.boolean().default(false),
  /** Slug de l'application, retapé. Exigé au forçage, ignoré sinon. */
  confirm: z.string().max(200).optional(),
});

export const POST = apiRoute<Context>(async (request, context) => {
  const auth = await requireCascadePermissions(request);
  const { id } = paramsSchema.parse(await context.params);
  const { force, confirm } = await readJsonBody(request, cascadeSchema);

  const application = await getApplication(id);
  if (!application) throw new NotFoundError(`Application « ${id} » introuvable`);

  const blockers = await listApplicationDeletionBlockers(id);

  // Un déploiement en cours ne se détruit pas et ne s'efface pas, forçage
  // compris : effacer la ligne sous le worker qui l'écrit laisserait la machine
  // dans un état que plus personne ne saurait décrire. C'est transitoire —
  // on attend.
  const inProgress = blockers.filter((blocker) => blocker.reason === 'in_progress');
  if (inProgress.length > 0) {
    throw new ConflictError(
      `${inProgress.length} déploiement(s) de « ${application.slug} » sont en cours : ` +
        `${inProgress.map((blocker) => `v${blocker.version} sur ${blocker.targetName}`).join(', ')}. ` +
        `Attendez qu'ils se terminent — le forçage ne s'applique pas à un déploiement en vol.`,
    );
  }

  if (force && confirm !== application.slug) {
    throw new HttpError(
      422,
      'confirmation_required',
      `Le forçage abandonne ${blockers.length} charge(s) sur leurs machines sans les arrêter : ` +
        `${blockers
          .map(
            (blocker) =>
              `${workspaceNameFor(application.slug)} sur ${blocker.targetName} (${blocker.targetHost}` +
              `${blocker.publishedPort === null ? '' : `, port ${blocker.publishedPort}`})`,
          )
          .join(' ; ')}. ` +
        `Recopiez « ${application.slug} » dans « confirm » pour confirmer.`,
      { expected: application.slug, abandons: describe(blockers, application.slug) },
    );
  }

  const job = await getOpsQueue().add(
    APPLICATION_DELETE_JOB,
    applicationDeleteJobDataSchema.parse({
      applicationId: id,
      force,
      actorId: auth.userId,
      ip: auth.ip,
    }),
    // Jamais rejouée : une destruction rejouée n'a pas de sens, et un
    // effacement rejoué porterait sur une application qui n'existe plus.
    { attempts: 1 },
  );
  if (!job.id) throw new HttpError(500, 'enqueue_failed', "La tâche n'a pas reçu d'identifiant");

  // Tracée **avant** que quoi que ce soit disparaisse : si le worker s'écroule
  // au milieu, le journal dit au moins ce qui avait été demandé, et sur quoi.
  await logAudit({
    actorId: auth.userId,
    action: force ? 'application.delete.force.requested' : 'application.delete.requested',
    resourceType: 'application',
    resourceId: id,
    before: { slug: application.slug },
    after: {
      jobId: job.id,
      forced: force,
      blockers: describe(blockers, application.slug),
    },
    ip: auth.ip,
  });

  return NextResponse.json(
    {
      id,
      jobId: job.id,
      state: 'queued',
      forced: force,
      blockers: describe(blockers, application.slug),
    },
    { status: 202 },
  );
});
