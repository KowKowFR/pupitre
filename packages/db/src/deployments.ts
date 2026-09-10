import {
  DEPLOYMENT_STEPS,
  scanConfigSchema,
  type AppSpec,
  type DeploymentStatus,
  type DeploymentStepKey,
  type ScanConfig,
  type StepStatus,
} from '@tp/core';
import { and, asc, count, desc, eq, inArray, lt, max, ne, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Database } from './client.js';
import { deploymentSteps, deployments, portAllocations } from './schema/deployments.js';
import { applications, targets } from './schema/infra.js';
import { users } from './schema/auth.js';

/**
 * Machine à états du déploiement.
 *
 * Les steps sont créées **au moment d'enfiler le job**, toutes en `pending` :
 * l'UI affiche le pipeline complet avant que le worker n'ait rien commencé.
 */

export type Deployment = typeof deployments.$inferSelect;
export type DeploymentStep = typeof deploymentSteps.$inferSelect;

export type DeploymentSummary = {
  id: string;
  status: DeploymentStatus;
  runtime: 'docker' | 'k3s';
  proxy: 'traefik' | 'bunkerweb';
  version: number;
  url: string | null;
  publishedPort: number | null;
  failedStep: string | null;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  applicationId: string;
  applicationSlug: string;
  targetId: string;
  targetName: string;
  targetHost: string;
  triggeredByEmail: string | null;
  previousDeploymentId: string | null;
  scanConfig: ScanConfig | null;
  autoRollback: boolean;
};

const summaryColumns = {
  id: deployments.id,
  status: deployments.status,
  runtime: deployments.runtime,
  proxy: deployments.proxy,
  version: deployments.version,
  url: deployments.url,
  publishedPort: deployments.publishedPort,
  failedStep: deployments.failedStep,
  error: deployments.error,
  startedAt: deployments.startedAt,
  finishedAt: deployments.finishedAt,
  createdAt: deployments.createdAt,
  applicationId: deployments.applicationId,
  applicationSlug: applications.slug,
  targetId: deployments.targetId,
  targetName: targets.name,
  targetHost: targets.host,
  triggeredByEmail: users.email,
  previousDeploymentId: deployments.previousDeploymentId,
  scanConfig: deployments.scanConfig,
  autoRollback: deployments.autoRollback,
} as const;

function summaryQuery(db: Database) {
  return db
    .select(summaryColumns)
    .from(deployments)
    .innerJoin(applications, eq(applications.id, deployments.applicationId))
    .innerJoin(targets, eq(targets.id, deployments.targetId))
    .leftJoin(users, eq(users.id, deployments.triggeredBy));
}

// ─── création ─────────────────────────────────────────────────────────────────

export const createDeploymentSchema = z.object({
  applicationId: z.string().uuid(),
  targetId: z.string().uuid(),
  runtime: z.enum(['docker', 'k3s']),
  proxy: z.enum(['traefik', 'bunkerweb']).default('traefik'),
  /**
   * Scanners et seuil de blocage. Absent = aucun scan : l'API n'impose pas de
   * politique à un client qui n'en parle pas. Le formulaire de l'UI, lui,
   * arrive avec les trois cases cochées et un blocage sur CRITICAL.
   */
  scanConfig: scanConfigSchema.prefault({}),
  /**
   * Retour automatique à la version précédente si le healthcheck échoue.
   *
   * Coché par défaut, ici comme dans le formulaire : perdre une version qui
   * marchait parce qu'on a oublié de cocher une case est le mauvais défaut.
   */
  autoRollback: z.boolean().default(true),
});

export type CreateDeploymentInput = z.infer<typeof createDeploymentSchema>;

/**
 * Crée le déploiement **et toutes ses steps en `pending`**, dans une seule
 * transaction. Le numéro de version est incrémental par application.
 */
export async function createDeploymentWithSteps(
  input: CreateDeploymentInput & {
    appSpec: AppSpec;
    triggeredBy: string | null;
  },
  db: Database = getDb(),
): Promise<{ deployment: Deployment; steps: DeploymentStep[] }> {
  return db.transaction(async (tx) => {
    const [latest] = await tx
      .select({ value: max(deployments.version) })
      .from(deployments)
      .where(eq(deployments.applicationId, input.applicationId));

    const version = (latest?.value ?? 0) + 1;

    // Dernier déploiement réussi : cible d'un éventuel rollback.
    const [previous] = await tx
      .select({ id: deployments.id })
      .from(deployments)
      .where(
        and(
          eq(deployments.applicationId, input.applicationId),
          eq(deployments.targetId, input.targetId),
          eq(deployments.status, 'success'),
        ),
      )
      .orderBy(desc(deployments.version))
      .limit(1);

    const [deployment] = await tx
      .insert(deployments)
      .values({
        applicationId: input.applicationId,
        targetId: input.targetId,
        runtime: input.runtime,
        proxy: input.proxy,
        status: 'pending',
        version,
        appSpec: input.appSpec,
        scanConfig: input.scanConfig,
        autoRollback: input.autoRollback,
        triggeredBy: input.triggeredBy,
        previousDeploymentId: previous?.id ?? null,
      })
      .returning();

    if (!deployment) throw new Error("createDeployment : l'insertion n'a rien retourné");

    const steps = await tx
      .insert(deploymentSteps)
      .values(
        DEPLOYMENT_STEPS.map((step, index) => ({
          deploymentId: deployment.id,
          order: index,
          key: step.key,
          label: step.label,
          status: 'pending' as const,
        })),
      )
      .returning();

    return { deployment, steps };
  });
}

// ─── lecture ──────────────────────────────────────────────────────────────────

export const deploymentQuerySchema = z.object({
  applicationId: z.string().uuid().optional(),
  targetId: z.string().uuid().optional(),
  status: z.enum(['pending', 'running', 'success', 'failed', 'rolled_back', 'destroyed']).optional(),
  runtime: z.enum(['docker', 'k3s']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type DeploymentQuery = z.infer<typeof deploymentQuerySchema>;

export type DeploymentPage = {
  items: DeploymentSummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export async function listDeployments(
  query: DeploymentQuery,
  db: Database = getDb(),
): Promise<DeploymentPage> {
  const filters = [
    query.applicationId ? eq(deployments.applicationId, query.applicationId) : undefined,
    query.targetId ? eq(deployments.targetId, query.targetId) : undefined,
    query.status ? eq(deployments.status, query.status) : undefined,
    query.runtime ? eq(deployments.runtime, query.runtime) : undefined,
  ].filter((filter) => filter !== undefined);

  const where = filters.length > 0 ? and(...filters) : undefined;

  const [items, [totalRow]] = await Promise.all([
    summaryQuery(db)
      .where(where)
      .orderBy(desc(deployments.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ value: count() }).from(deployments).where(where),
  ]);

  const total = totalRow?.value ?? 0;

  return {
    items,
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

export async function getDeploymentSummary(
  id: string,
  db: Database = getDb(),
): Promise<DeploymentSummary | null> {
  const [row] = await summaryQuery(db).where(eq(deployments.id, id));
  return row ?? null;
}

export async function listSteps(
  deploymentId: string,
  db: Database = getDb(),
): Promise<DeploymentStep[]> {
  return db
    .select()
    .from(deploymentSteps)
    .where(eq(deploymentSteps.deploymentId, deploymentId))
    .orderBy(asc(deploymentSteps.order));
}

/** Tout ce dont le worker a besoin, en une requête. */
export async function getDeploymentForRun(
  id: string,
  db: Database = getDb(),
): Promise<{ deployment: Deployment; steps: DeploymentStep[] } | null> {
  const [deployment] = await db.select().from(deployments).where(eq(deployments.id, id));
  if (!deployment) return null;
  return { deployment, steps: await listSteps(id, db) };
}

// ─── transitions ──────────────────────────────────────────────────────────────

export async function markDeploymentRunning(
  id: string,
  db: Database = getDb(),
): Promise<void> {
  await db
    .update(deployments)
    .set({ status: 'running', startedAt: new Date(), error: null, failedStep: null, updatedAt: new Date() })
    .where(eq(deployments.id, id));
}

export async function finishDeployment(
  id: string,
  status: DeploymentStatus,
  detail: {
    url?: string | null;
    publishedPort?: number | null;
    imageTag?: string | null;
    failedStep?: string | null;
    error?: string | null;
  } = {},
  db: Database = getDb(),
): Promise<void> {
  await db
    .update(deployments)
    .set({
      status,
      finishedAt: new Date(),
      updatedAt: new Date(),
      ...(detail.url !== undefined ? { url: detail.url } : {}),
      ...(detail.publishedPort !== undefined ? { publishedPort: detail.publishedPort } : {}),
      ...(detail.imageTag !== undefined ? { imageTag: detail.imageTag } : {}),
      ...(detail.failedStep !== undefined ? { failedStep: detail.failedStep } : {}),
      ...(detail.error !== undefined ? { error: detail.error } : {}),
    })
    .where(eq(deployments.id, id));
}

export async function startStep(
  deploymentId: string,
  key: DeploymentStepKey,
  db: Database = getDb(),
): Promise<void> {
  await db
    .update(deploymentSteps)
    .set({ status: 'running', startedAt: new Date(), finishedAt: null, error: null })
    .where(and(eq(deploymentSteps.deploymentId, deploymentId), eq(deploymentSteps.key, key)));
}

export async function finishStep(
  deploymentId: string,
  key: DeploymentStepKey,
  status: Exclude<StepStatus, 'pending' | 'running'>,
  error: string | null = null,
  db: Database = getDb(),
): Promise<void> {
  await db
    .update(deploymentSteps)
    .set({ status, finishedAt: new Date(), error })
    .where(and(eq(deploymentSteps.deploymentId, deploymentId), eq(deploymentSteps.key, key)));
}

/** Après un échec : tout ce qui n'a pas tourné passe en `skipped`. */
export async function skipPendingSteps(
  deploymentId: string,
  db: Database = getDb(),
): Promise<DeploymentStepKey[]> {
  const rows = await db
    .update(deploymentSteps)
    .set({ status: 'skipped', finishedAt: new Date() })
    .where(
      and(
        eq(deploymentSteps.deploymentId, deploymentId),
        inArray(deploymentSteps.status, ['pending', 'running']),
      ),
    )
    .returning({ key: deploymentSteps.key });

  return rows.map((row) => row.key as DeploymentStepKey);
}

/**
 * Remet en `pending` tout ce qui n'a pas abouti, pour une relance.
 * Les steps déjà `success` restent telles quelles : c'est ce qui rend le job
 * idempotent.
 */
export async function resetUnsuccessfulSteps(
  deploymentId: string,
  db: Database = getDb(),
): Promise<void> {
  await db
    .update(deploymentSteps)
    .set({ status: 'pending', startedAt: null, finishedAt: null, error: null })
    .where(
      and(
        eq(deploymentSteps.deploymentId, deploymentId),
        ne(deploymentSteps.status, 'success'),
      ),
    );
}

// ─── journal ──────────────────────────────────────────────────────────────────

/**
 * Ajoute un bloc de lignes au journal d'une étape.
 * L'append est fait par la base (`log || $chunk`) : deux écritures concurrentes
 * ne peuvent pas s'écraser.
 */
export async function appendStepLog(
  deploymentId: string,
  key: DeploymentStepKey,
  chunk: string,
  db: Database = getDb(),
): Promise<void> {
  if (chunk.length === 0) return;
  await db
    .update(deploymentSteps)
    .set({ log: sql`${deploymentSteps.log} || ${chunk}` })
    .where(and(eq(deploymentSteps.deploymentId, deploymentId), eq(deploymentSteps.key, key)));
}

/** Journal complet, dans l'ordre des étapes. Sert à la relecture SSE. */
export async function readDeploymentLog(
  deploymentId: string,
  db: Database = getDb(),
): Promise<Array<{ key: string; log: string }>> {
  const rows = await db
    .select({ key: deploymentSteps.key, log: deploymentSteps.log })
    .from(deploymentSteps)
    .where(eq(deploymentSteps.deploymentId, deploymentId))
    .orderBy(asc(deploymentSteps.order));

  return rows.filter((row) => row.log.length > 0);
}

// ─── historique des versions ──────────────────────────────────────────────────

/** Une version déployée, telle que la timeline de l'application la montre. */
export type ApplicationVersion = {
  deploymentId: string;
  version: number;
  /** Version applicative issue de l'AppSpec figée à ce déploiement. */
  appVersion: string | null;
  imageTag: string | null;
  runtime: 'docker' | 'k3s';
  status: DeploymentStatus;
  url: string | null;
  publishedPort: number | null;
  targetId: string;
  targetName: string;
  triggeredByEmail: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  /** Une version sans AppSpec n'est pas redéployable : il n'y a rien à rejouer. */
  redeployable: boolean;
};

/**
 * Historique complet d'une application, du plus récent au plus ancien.
 *
 * On lit `deployments`, jamais une table d'historique séparée : le déploiement
 * *est* la version. Son `app_spec` figée est ce qui rend un redéploiement
 * possible des mois plus tard, même si l'application a changé depuis.
 */
export async function listApplicationVersions(
  applicationId: string,
  db: Database = getDb(),
): Promise<ApplicationVersion[]> {
  const rows = await db
    .select({
      deploymentId: deployments.id,
      version: deployments.version,
      appSpec: deployments.appSpec,
      imageTag: deployments.imageTag,
      runtime: deployments.runtime,
      status: deployments.status,
      url: deployments.url,
      publishedPort: deployments.publishedPort,
      targetId: deployments.targetId,
      targetName: targets.name,
      triggeredByEmail: users.email,
      createdAt: deployments.createdAt,
      finishedAt: deployments.finishedAt,
    })
    .from(deployments)
    .innerJoin(targets, eq(targets.id, deployments.targetId))
    .leftJoin(users, eq(users.id, deployments.triggeredBy))
    .where(eq(deployments.applicationId, applicationId))
    .orderBy(desc(deployments.version));

  return rows.map((row) => {
    const { appSpec, ...rest } = row;
    return {
      ...rest,
      appVersion: appSpec?.version ?? null,
      redeployable: appSpec !== null,
    };
  });
}

// ─── « ce qui tourne » — définition unique ───────────────────────────────────

/**
 * ## La seule définition de « vivant »
 *
 * Pour un couple (application, cible), on lit son historique **du plus récent au
 * plus ancien** et on s'arrête au premier verdict :
 *
 * - `pending` / `running` : aucun verdict encore, on continue de descendre. Un
 *   déploiement en cours ne fait pas disparaître ce qui tourne pendant ce
 *   temps-là.
 * - `failed` : on **retient** le plus récent comme « dernière mise à jour
 *   échouée », mais on continue de descendre. Un échec ne remplace pas
 *   forcément ce qui tournait — voir `startedServices()`.
 * - `success` / `rolled_back` : c'est **le** déploiement en service. Un
 *   `rolled_back` compte autant qu'un `success` : après un rollback, c'est bien
 *   l'ancienne version qui sert.
 *
 * Si la descente n'a trouvé aucun déploiement en service mais que le dernier
 * échec est survenu **à partir de l'étape `deploy`**, le couple est quand même
 * considéré occupé : des conteneurs ont pu démarrer et rester là.
 *
 * Une destruction (`destroyed`) coupe cette descente, mais **par le temps et non
 * par le numéro de version** : `destroy` démonte le projet `app-{slug}` entier,
 * pas la seule version sur laquelle on l'a lancé. Tout déploiement terminé avant
 * la dernière destruction a donc disparu de la machine, y compris un numéro de
 * version supérieur. Détruire la v1 emporte la v2 avec elle.
 *
 * ### Pourquoi elle penche de ce côté
 *
 * La base ne dit pas ce que la machine porte, elle dit ce que le panel croit.
 * Entre les deux erreurs possibles, le coût n'est pas le même :
 *
 * - se tromper en gardant un couple de trop → une ligne en surplus dans l'écran
 *   de supervision, et un déploiement qu'on doit détruire avant de le purger ;
 * - se tromper en l'oubliant → une application qui tourne toujours sur la
 *   machine mais que le panel ne sait plus nommer : plus de logs, plus de
 *   rollback, plus de destruction propre, et un port réservé pour un fantôme.
 *
 * La seconde n'est pas rattrapable depuis le panel. **En cas de doute, on
 * considère donc que quelque chose tourne encore.** C'est pour la même raison
 * qu'un `failed_step` inconnu ou absent est traité comme « les services ont pu
 * démarrer ».
 *
 * L'inventaire réel de la cible (`listWorkloads` sur le `DeploymentDriver`) dirait
 * la vérité, lui. Il n'est délibérément pas appelé ici : cette fonction sert le
 * chemin de la purge, qui est une opération de base de données et ne doit pas
 * dépendre de la joignabilité d'une machine distante — une cible éteinte rendrait
 * l'historique impurgeable.
 */

/** L'index de `deploy` : la première étape qui démarre réellement des services. */
const DEPLOY_STEP_INDEX = DEPLOYMENT_STEPS.findIndex((step) => step.key === 'deploy');

/**
 * Ce déploiement échoué a-t-il pu laisser des conteneurs derrière lui ?
 *
 * Tout ce qui précède `deploy` — préflight, réservation, rendu, dépôt, build,
 * scan — peut échouer sans que rien ne tourne : la version précédente n'a jamais
 * cessé de servir. À partir de `deploy`, la cible a été touchée.
 */
function startedServices(failedStep: string | null): boolean {
  // Pas d'étape nommée : on ne sait pas où ça s'est arrêté, donc on suppose le pire.
  if (failedStep === null) return true;
  const index = DEPLOYMENT_STEPS.findIndex((step) => step.key === failedStep);
  if (index === -1) return true;
  return index >= DEPLOY_STEP_INDEX;
}

/** Ce qu'un couple (application, cible) porte encore, selon la définition ci-dessus. */
export type LiveDeployment = {
  applicationId: string;
  targetId: string;
  /**
   * Le déploiement qui sert l'application. `null` quand seul un échec occupe la
   * cible : rien n'a jamais abouti sur ce couple.
   */
  inService: Deployment | null;
  /** Le dernier déploiement du couple s'il a échoué, et qu'aucun ne lui a succédé. */
  lastFailed: Deployment | null;
  /**
   * Les déploiements dont la trace en base ne doit pas être effacée : ce sont
   * les seules poignées qui restent pour retrouver, arrêter ou détruire ce qui
   * tourne. Le `lastFailed` n'en fait partie que s'il est la seule poignée.
   */
  pinnedIds: string[];
};

/** Applique la définition à l'historique d'un seul couple, du plus récent au plus ancien. */
function resolveLive(rows: Deployment[]): LiveDeployment | null {
  // Date de la dernière destruction du couple : tout ce qui s'est terminé avant
  // elle a été démonté avec le projet, quel que soit son numéro de version.
  let destroyedAt: Date | null = null;
  for (const row of rows) {
    if (row.status !== 'destroyed' || row.finishedAt === null) continue;
    if (destroyedAt === null || row.finishedAt > destroyedAt) destroyedAt = row.finishedAt;
  }

  // `finishedAt` absent : on ne sait pas dater, donc on suppose que ça a survécu.
  const survives = (row: Deployment): boolean =>
    destroyedAt === null || row.finishedAt === null || row.finishedAt > destroyedAt;

  let lastFailed: Deployment | null = null;
  let inService: Deployment | null = null;

  for (const row of rows) {
    // `pending` / `running` : pas encore de verdict. `destroyed` : déjà pris en
    // compte par `destroyedAt`.
    if (row.status === 'pending' || row.status === 'running' || row.status === 'destroyed') continue;
    if (!survives(row)) continue;

    if (row.status === 'failed') {
      lastFailed ??= row;
      continue;
    }

    inService = row;
    break;
  }

  if (inService !== null) {
    return {
      applicationId: inService.applicationId,
      targetId: inService.targetId,
      inService,
      lastFailed,
      pinnedIds: [inService.id],
    };
  }

  if (lastFailed !== null && startedServices(lastFailed.failedStep)) {
    return {
      applicationId: lastFailed.applicationId,
      targetId: lastFailed.targetId,
      inService: null,
      lastFailed,
      pinnedIds: [lastFailed.id],
    };
  }

  return null;
}

/**
 * Tous les couples (application, cible) sur lesquels quelque chose peut encore
 * tourner. **C'est l'unique définition** : supervision, purge et worker en
 * dérivent tous, aucun ne réécrit la règle.
 */
export async function listLiveDeployments(
  filter: { applicationId?: string; targetId?: string } = {},
  db: Database = getDb(),
): Promise<LiveDeployment[]> {
  const conditions = [
    filter.applicationId ? eq(deployments.applicationId, filter.applicationId) : undefined,
    filter.targetId ? eq(deployments.targetId, filter.targetId) : undefined,
  ].filter((condition) => condition !== undefined);

  const rows = await db
    .select()
    .from(deployments)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(deployments.version), desc(deployments.createdAt));

  const couples = new Map<string, Deployment[]>();
  for (const row of rows) {
    const key = `${row.applicationId}|${row.targetId}`;
    const bucket = couples.get(key);
    if (bucket) bucket.push(row);
    else couples.set(key, [row]);
  }

  const live: LiveDeployment[] = [];
  for (const bucket of couples.values()) {
    const resolved = resolveLive(bucket);
    if (resolved) live.push(resolved);
  }
  return live;
}

/**
 * Reste-t-il quelque chose de vivant de cette application sur cette cible ?
 *
 * Sert au worker à décider s'il peut relâcher la réservation de port après un
 * échec. Le déploiement qui vient d'échouer **n'est pas exclu** de la question :
 * s'il a dépassé `deploy`, ce sont ses propres conteneurs qui occupent le port,
 * et le rendre le donnerait à une autre application.
 */
export async function hasLiveDeploymentOnTarget(
  applicationId: string,
  targetId: string,
  db: Database = getDb(),
): Promise<boolean> {
  const live = await listLiveDeployments({ applicationId, targetId }, db);
  return live.length > 0;
}

/**
 * Le déploiement **en service** de chaque couple — celui que les tâches
 * périodiques sondent et scannent.
 *
 * Dérivé de `listLiveDeployments()` : un couple seulement occupé par un échec
 * n'a rien à sonder, il n'apparaît pas ici.
 */
export async function listCurrentDeployments(
  db: Database = getDb(),
): Promise<Deployment[]> {
  const live = await listLiveDeployments({}, db);
  return live
    .map((row) => row.inService)
    .filter((row): row is Deployment => row !== null);
}

/** Statut de santé constaté par la sonde périodique. N'entraîne aucune action. */
export async function recordHealthStatus(
  id: string,
  status: 'unknown' | 'healthy' | 'unhealthy' | 'unreachable',
  at: Date = new Date(),
  db: Database = getDb(),
): Promise<void> {
  await db
    .update(deployments)
    .set({ healthStatus: status, lastHealthAt: at })
    .where(eq(deployments.id, id));
}


/**
 * La dernière mise à jour du couple, quand elle a échoué.
 *
 * Présente, elle dit que le déploiement en service **n'est plus le dernier
 * essai** : quelqu'un a tenté de le remplacer et s'est planté. L'écran doit le
 * dire franchement plutôt que de faire disparaître la ligne.
 */
export type LastFailedUpdate = {
  deploymentId: string;
  version: number;
  failedStep: string | null;
  error: string | null;
  finishedAt: Date | null;
  /** L'échec est survenu à partir de `deploy` : les conteneurs ont pu être remplacés. */
  mayHaveReplacedServices: boolean;
};

/** Une application en marche, telle que l'écran de supervision la présente. */
export type SupervisedApp = DeploymentSummary & {
  healthStatus: 'unknown' | 'healthy' | 'unhealthy' | 'unreachable';
  lastHealthAt: Date | null;
  appName: string;
  services: string[];
  lastFailedUpdate: LastFailedUpdate | null;
};

/**
 * Ce qui tourne *maintenant*, une ligne par couple (application, cible).
 *
 * Distinct de `listDeployments`, qui raconte l'historique. La règle de sélection
 * est celle de `listLiveDeployments()` — elle n'est pas réécrite ici. La ligne
 * porte l'identifiant du déploiement **en service** (`success` ou
 * `rolled_back`), seul état où les logs applicatifs et le redémarrage ont un
 * sens ; un échec plus récent apparaît dans `lastFailedUpdate` au lieu de faire
 * disparaître l'application.
 */
export async function listSupervisedApps(db: Database = getDb()): Promise<SupervisedApp[]> {
  const live = await listLiveDeployments({}, db);

  const inService = new Map<string, LiveDeployment>();
  for (const row of live) {
    if (row.inService) inService.set(row.inService.id, row);
  }
  if (inService.size === 0) return [];

  const rows = await db
    .select({
      ...summaryColumns,
      healthStatus: deployments.healthStatus,
      lastHealthAt: deployments.lastHealthAt,
      appName: applications.name,
      appSpec: deployments.appSpec,
    })
    .from(deployments)
    .innerJoin(applications, eq(applications.id, deployments.applicationId))
    .innerJoin(targets, eq(targets.id, deployments.targetId))
    .leftJoin(users, eq(users.id, deployments.triggeredBy))
    .where(inArray(deployments.id, [...inService.keys()]));

  return rows
    .map(({ appSpec, ...row }) => {
      const failed = inService.get(row.id)?.lastFailed ?? null;
      return {
        ...row,
        services: appSpec?.services.map((service) => service.name) ?? [],
        lastFailedUpdate: failed
          ? {
              deploymentId: failed.id,
              version: failed.version,
              failedStep: failed.failedStep,
              error: failed.error,
              finishedAt: failed.finishedAt,
              mayHaveReplacedServices: startedServices(failed.failedStep),
            }
          : null,
      };
    })
    .sort((a, b) => a.applicationSlug.localeCompare(b.applicationSlug));
}

// ─── purge de l'historique ────────────────────────────────────────────────────

/**
 * Purger n'est pas détruire.
 *
 * `destroy` va sur la machine cible et démonte l'application. Purger efface la
 * **trace en base** d'un déploiement, sans toucher à la cible. D'où l'unique
 * garde-fou : on ne purge pas un déploiement qui supervise quelque chose de
 * vivant, sinon l'application continuerait de tourner sur la machine sans que
 * le panel sache encore la nommer — plus de logs, plus de rollback, plus de
 * destruction possible, et son port resterait réservé pour un fantôme.
 */

/** Pourquoi un déploiement a résisté à la purge. */
export type PurgeRefusalReason = 'live' | 'in_progress';

export type PurgeRefusal = {
  id: string;
  status: DeploymentStatus;
  version: number;
  applicationSlug: string;
  targetName: string;
  reason: PurgeRefusalReason;
  message: string;
};

/**
 * Plafond de lignes traitées par appel.
 *
 * Choix assumé de la **route synchrone** plutôt que d'un job BullMQ : la purge
 * est un `DELETE ... WHERE id = ANY(...)` dans une transaction, avec des
 * cascades sur des clés étrangères indexées. À 500 lignes c'est une affaire de
 * dizaines de millisecondes, très loin d'une « opération longue » au sens de la
 * règle 2 — laquelle vise le travail distant (SSH, build, scan), pas une
 * écriture locale bornée. Passer par la queue coûterait un aller-retour et,
 * surtout, rendrait *asynchrone* la seule information qui compte ici : ce qui a
 * été refusé et pourquoi. On borne donc, et on le dit dans la réponse
 * (`truncated`) plutôt que de laisser la requête grossir sans limite.
 */
export const PURGE_MAX_ROWS = 500;

export const purgeFilterSchema = z
  .object({
    /** Sélection explicite — c'est ce que coche l'utilisateur dans le tableau. */
    ids: z.array(z.string().uuid()).min(1).max(PURGE_MAX_ROWS).optional(),
    statuses: z
      .array(z.enum(['pending', 'running', 'success', 'failed', 'rolled_back', 'destroyed']))
      .min(1)
      .optional(),
    /** « Plus vieux que N jours », calculé sur `created_at`. */
    olderThanDays: z.number().int().min(0).max(3650).optional(),
    applicationId: z.string().uuid().optional(),
    targetId: z.string().uuid().optional(),
  })
  .refine(
    (filter) =>
      filter.ids !== undefined ||
      filter.statuses !== undefined ||
      filter.olderThanDays !== undefined ||
      filter.applicationId !== undefined ||
      filter.targetId !== undefined,
    {
      // Un filtre vide viserait tout l'historique. Ce n'est pas une purge, c'est
      // un accident : on exige au moins un critère.
      message: 'Au moins un critère est requis (ids, statuses, olderThanDays, applicationId, targetId)',
    },
  );

export type PurgeFilter = z.infer<typeof purgeFilterSchema>;

export type PurgeReport = {
  /** Déploiements correspondant au filtre, plafond non appliqué. */
  matched: number;
  /** Ce qui a été (ou serait) effacé. */
  purged: string[];
  purgedCount: number;
  /** Décompte par statut de ce qui a été (ou serait) effacé. */
  purgedByStatus: Record<string, number>;
  refused: PurgeRefusal[];
  refusedCount: number;
  /** Réservations rendues à la plage de ports de leur cible. */
  releasedPorts: Array<{ targetId: string; targetName: string; port: number }>;
  /**
   * Déploiements vivants qui perdent leur cible de rollback : `previous_deployment_id`
   * est en `ON DELETE SET NULL`, purger une version historique la coupe.
   */
  rollbackTargetsLost: number;
  /** Le plafond a coupé la sélection : il reste des lignes à purger. */
  truncated: boolean;
  limit: number;
  dryRun: boolean;
};

/** Pourquoi un déploiement est la dernière poignée du panel sur quelque chose de vivant. */
type PinnedKind = 'in_service' | 'only_handle';

/**
 * Déploiements qu'on refuse de purger, et la raison.
 *
 * Délègue à `listLiveDeployments()` — l'unique définition de « vivant ». Le
 * réécrire ici, c'est se condamner à ce que les deux divergent un jour ; c'est
 * exactement ce qui était arrivé, et qui rendait purgeable la version en service
 * d'une application dont la dernière mise à jour avait échoué.
 */
export async function listPinnedDeployments(
  db: Database = getDb(),
): Promise<Map<string, PinnedKind>> {
  const live = await listLiveDeployments({}, db);
  const pinned = new Map<string, PinnedKind>();
  for (const row of live) {
    for (const id of row.pinnedIds) {
      pinned.set(id, row.inService ? 'in_service' : 'only_handle');
    }
  }
  return pinned;
}

/** Les mêmes, sans la raison — l'écran des déploiements grise la case avec. */
export async function listLiveDeploymentIds(db: Database = getDb()): Promise<Set<string>> {
  return new Set((await listPinnedDeployments(db)).keys());
}

type PurgeCandidate = {
  id: string;
  status: DeploymentStatus;
  version: number;
  applicationId: string;
  applicationSlug: string;
  targetId: string;
  targetName: string;
};

function purgeWhere(filter: PurgeFilter) {
  const now = Date.now();
  const conditions = [
    filter.ids ? inArray(deployments.id, filter.ids) : undefined,
    filter.statuses ? inArray(deployments.status, filter.statuses) : undefined,
    filter.olderThanDays !== undefined
      ? lt(deployments.createdAt, new Date(now - filter.olderThanDays * 86_400_000))
      : undefined,
    filter.applicationId ? eq(deployments.applicationId, filter.applicationId) : undefined,
    filter.targetId ? eq(deployments.targetId, filter.targetId) : undefined,
  ].filter((condition) => condition !== undefined);

  return conditions.length > 0 ? and(...conditions) : undefined;
}

/**
 * Prévisualise puis exécute la purge.
 *
 * `dryRun` emprunte exactement le même chemin de décision : le décompte annoncé
 * à l'utilisateur est celui qui sera appliqué, pas une estimation calculée
 * ailleurs.
 */
export async function purgeDeployments(
  filter: PurgeFilter,
  options: { dryRun?: boolean } = {},
  db: Database = getDb(),
): Promise<PurgeReport> {
  const dryRun = options.dryRun ?? false;
  const where = purgeWhere(filter);

  const [candidates, [totalRow], pinned] = await Promise.all([
    db
      .select({
        id: deployments.id,
        status: deployments.status,
        version: deployments.version,
        applicationId: deployments.applicationId,
        applicationSlug: applications.slug,
        targetId: deployments.targetId,
        targetName: targets.name,
      })
      .from(deployments)
      .innerJoin(applications, eq(applications.id, deployments.applicationId))
      .innerJoin(targets, eq(targets.id, deployments.targetId))
      .where(where)
      // Le plus ancien d'abord : si le plafond coupe, il coupe la queue récente,
      // et deux appels successifs finissent le travail.
      .orderBy(asc(deployments.createdAt))
      .limit(PURGE_MAX_ROWS),
    db.select({ value: count() }).from(deployments).where(where),
    listPinnedDeployments(db),
  ]);

  const matched = totalRow?.value ?? 0;

  const purgeable: PurgeCandidate[] = [];
  const refused: PurgeRefusal[] = [];

  for (const candidate of candidates) {
    const refusal = refuse(candidate, pinned);
    if (refusal) refused.push(refusal);
    else purgeable.push(candidate);
  }

  const purgedByStatus: Record<string, number> = {};
  for (const row of purgeable) {
    purgedByStatus[row.status] = (purgedByStatus[row.status] ?? 0) + 1;
  }

  const ids = purgeable.map((row) => row.id);

  const base: PurgeReport = {
    matched,
    purged: ids,
    purgedCount: ids.length,
    purgedByStatus,
    refused,
    refusedCount: refused.length,
    releasedPorts: [],
    rollbackTargetsLost: 0,
    truncated: matched > candidates.length,
    limit: PURGE_MAX_ROWS,
    dryRun,
  };

  if (ids.length === 0) return base;

  const rollbackTargetsLost = await countRollbackTargetsLost(ids, db);

  if (dryRun) return { ...base, rollbackTargetsLost };

  const releasedPorts = await db.transaction(async (tx) => {
    await tx.delete(deployments).where(inArray(deployments.id, ids));

    // `deployment_steps`, `scan_runs` et leurs `findings` partent en cascade
    // (clé étrangère `ON DELETE CASCADE`). `audit_logs` non : sa colonne
    // `resource_id` est un `text` sans clé étrangère — le journal survit à ce
    // qu'il décrit, et c'est voulu.
    return releaseOrphanAllocations(purgeable, tx);
  });

  return { ...base, releasedPorts, rollbackTargetsLost };
}

/** Le seul verdict qui compte : ce déploiement supervise-t-il quelque chose ? */
function refuse(
  candidate: PurgeCandidate,
  pinned: ReadonlyMap<string, PinnedKind>,
): PurgeRefusal | null {
  const identity = `${candidate.applicationSlug} v${candidate.version} sur ${candidate.targetName}`;

  if (candidate.status === 'pending' || candidate.status === 'running') {
    return {
      ...refusalIdentity(candidate),
      reason: 'in_progress',
      message: `${identity} est en cours d'exécution. Attendez qu'il se termine avant de le purger.`,
    };
  }

  const kind = pinned.get(candidate.id);
  if (kind === 'in_service') {
    return {
      ...refusalIdentity(candidate),
      reason: 'live',
      message:
        `${identity} est la version en service sur cette cible : la purger ferait ` +
        `disparaître du panel une application qui tourne toujours. Détruisez-la d'abord.`,
    };
  }

  if (kind === 'only_handle') {
    return {
      ...refusalIdentity(candidate),
      reason: 'live',
      message:
        `${identity} a échoué après avoir démarré les services : des conteneurs peuvent ` +
        `tourner encore sur cette cible, et c'est la seule trace qui permette de les ` +
        `retrouver. Détruisez-le d'abord.`,
    };
  }

  return null;
}

function refusalIdentity(candidate: PurgeCandidate): Omit<PurgeRefusal, 'reason' | 'message'> {
  return {
    id: candidate.id,
    status: candidate.status,
    version: candidate.version,
    applicationSlug: candidate.applicationSlug,
    targetName: candidate.targetName,
  };
}

/** Déploiements survivants dont la cible de rollback est sur le point de disparaître. */
async function countRollbackTargetsLost(ids: string[], db: Database): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(deployments)
    .where(
      and(
        inArray(deployments.previousDeploymentId, ids),
        // Un déploiement lui-même purgé ne « perd » rien.
        notInArray(deployments.id, ids),
      ),
    );
  return row?.value ?? 0;
}

/**
 * Rend à la plage de ports les réservations que la purge vient d'orpheliner.
 *
 * `port_allocations` est indexée par (cible, application) et non par
 * déploiement : la réservation ne se libère donc que s'il ne reste **plus aucun**
 * déploiement de ce couple. Tant qu'il en reste un, quelque chose peut encore
 * occuper ce port sur la machine, et le rendre reviendrait à le promettre à une
 * autre application.
 */
async function releaseOrphanAllocations(
  purged: PurgeCandidate[],
  tx: Database,
): Promise<Array<{ targetId: string; targetName: string; port: number }>> {
  const couples = new Map<string, { applicationId: string; targetId: string; targetName: string }>();
  for (const row of purged) {
    couples.set(`${row.applicationId}|${row.targetId}`, {
      applicationId: row.applicationId,
      targetId: row.targetId,
      targetName: row.targetName,
    });
  }

  const released: Array<{ targetId: string; targetName: string; port: number }> = [];

  for (const couple of couples.values()) {
    const [remaining] = await tx
      .select({ id: deployments.id })
      .from(deployments)
      .where(
        and(
          eq(deployments.applicationId, couple.applicationId),
          eq(deployments.targetId, couple.targetId),
        ),
      )
      .limit(1);

    if (remaining) continue;

    const rows = await tx
      .delete(portAllocations)
      .where(
        and(
          eq(portAllocations.targetId, couple.targetId),
          eq(portAllocations.applicationId, couple.applicationId),
        ),
      )
      .returning({ port: portAllocations.port });

    for (const row of rows) {
      released.push({ targetId: couple.targetId, targetName: couple.targetName, port: row.port });
    }
  }

  return released;
}
