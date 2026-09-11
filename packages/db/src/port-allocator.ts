import {
  PortExhaustedError,
  portRangeSize,
  type PortAllocationKey,
  type PortAllocationRequest,
  type PortAllocator,
  type PortRange,
} from '@tp/core';
import { and, asc, desc, eq } from 'drizzle-orm';
import { getDb, type Database } from './client.js';
import { deployments, portAllocations } from './schema/deployments.js';
import { applications, targets } from './schema/infra.js';

/**
 * Implémentation de `PortAllocator` adossée à `port_allocations`.
 *
 * L'unicité vient de la contrainte `(target_id, port)`, pas d'un test en
 * TypeScript : deux workers qui visent le même port au même instant produisent
 * une violation `23505`, et celui qui perd rejoue. C'est la base qui tranche.
 */

/** Violation de contrainte d'unicité côté PostgreSQL. */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

const MAX_ATTEMPTS = 50;

export function createPortAllocator(db: Database = getDb()): PortAllocator {
  async function current(key: PortAllocationKey): Promise<number | null> {
    const [row] = await db
      .select({ port: portAllocations.port })
      .from(portAllocations)
      .where(
        and(
          eq(portAllocations.targetId, key.targetId),
          eq(portAllocations.applicationId, key.applicationId),
        ),
      );
    return row?.port ?? null;
  }

  async function allocate(request: PortAllocationRequest): Promise<number> {
    const existing = await current(request);
    if (existing !== null) return existing;

    const excluded = new Set(request.exclude ?? []);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      // Relu à chaque tentative : une autre transaction a pu réserver entre-temps.
      const taken = new Set(
        (
          await db
            .select({ port: portAllocations.port })
            .from(portAllocations)
            .where(eq(portAllocations.targetId, request.targetId))
        ).map((row) => row.port),
      );

      const free: number[] = [];
      for (let port = request.min; port <= request.max; port += 1) {
        // `excluded` : ports que l'appelant a constatés occupés sur la machine
        // elle-même. La base ne peut pas le savoir — elle ne connaît que les
        // réservations du panel.
        if (!taken.has(port) && !excluded.has(port)) free.push(port);
      }
      if (free.length === 0) {
        throw new PortExhaustedError(request.targetId, request.min, request.max);
      }

      // Tirage aléatoire : deux workers simultanés ne visent pas le même port,
      // ce qui rend la collision rare plutôt que systématique.
      const candidate = free[Math.floor(Math.random() * free.length)];
      if (candidate === undefined) continue;

      try {
        // Une transaction pour l'écriture : l'INSERT *est* le test d'unicité.
        // Un SELECT suivi d'un INSERT laisserait une fenêtre entre les deux, et
        // c'est exactement la fenêtre que deux workers simultanés trouveraient.
        const row = await db.transaction(async (tx) => {
          const [inserted] = await tx
            .insert(portAllocations)
            .values({
              targetId: request.targetId,
              applicationId: request.applicationId,
              port: candidate,
            })
            .returning({ port: portAllocations.port });
          return inserted;
        });

        if (row) return row.port;
      } catch (error) {
        if (isUniqueViolation(error)) {
          // Quelqu'un a pris ce port — ou cette application vient d'en obtenir
          // un par une autre transaction. On relit avant de retenter.
          const raced = await current(request);
          if (raced !== null) return raced;
          continue;
        }
        throw error;
      }
    }

    throw new PortExhaustedError(request.targetId, request.min, request.max);
  }

  async function release(key: PortAllocationKey): Promise<void> {
    await db
      .delete(portAllocations)
      .where(
        and(
          eq(portAllocations.targetId, key.targetId),
          eq(portAllocations.applicationId, key.applicationId),
        ),
      );
  }

  return { allocate, release, current };
}

/**
 * Réservations d'une application, toutes cibles confondues.
 *
 * `port_allocations` est indexée par (cible, application) et non par
 * déploiement : c'est donc **ici** qu'on lit ce qu'une suppression rendra, et
 * pas en additionnant les `published_port` des déploiements — un couple peut
 * tenir une réservation sans qu'aucun déploiement n'ait abouti.
 */
export async function listApplicationPortAllocations(
  applicationId: string,
  db: Database = getDb(),
): Promise<Array<{ targetId: string; targetName: string; port: number }>> {
  return db
    .select({
      targetId: portAllocations.targetId,
      targetName: targets.name,
      port: portAllocations.port,
    })
    .from(portAllocations)
    .innerJoin(targets, eq(targets.id, portAllocations.targetId))
    .where(eq(portAllocations.applicationId, applicationId))
    .orderBy(asc(portAllocations.port));
}

// ─── vue d'ensemble ───────────────────────────────────────────────────────────

/** Une réservation, telle que l'API et l'UI la présentent. */
export type PortAllocationView = {
  port: number;
  applicationId: string;
  applicationSlug: string;
  /** Dernier déploiement de cette application sur cette cible, s'il existe. */
  deploymentId: string | null;
  deploymentStatus: string | null;
  url: string | null;
  reservedAt: Date;
};

export type TargetPortReport = {
  targetId: string;
  targetName: string;
  range: PortRange;
  /** Ports de la plage, tous usages confondus. */
  capacity: number;
  used: number;
  free: number;
  allocations: PortAllocationView[];
  /**
   * Premiers ports libres, à titre indicatif. La liste est tronquée : montrer
   * les 2 768 ports libres d'une plage par défaut n'apprendrait rien.
   */
  freeSample: number[];
};

const FREE_SAMPLE = 20;

/**
 * État de l'allocation de ports d'une cible.
 *
 * La plage vient de la cible elle-même : c'est elle qui sait ce que son
 * pare-feu laisse passer.
 */
export async function getTargetPortReport(
  targetId: string,
  db: Database = getDb(),
): Promise<TargetPortReport | null> {
  const [target] = await db
    .select({
      id: targets.id,
      name: targets.name,
      min: targets.portRangeStart,
      max: targets.portRangeEnd,
    })
    .from(targets)
    .where(eq(targets.id, targetId));

  if (!target) return null;

  const rows = await db
    .select({
      port: portAllocations.port,
      applicationId: portAllocations.applicationId,
      applicationSlug: applications.slug,
      reservedAt: portAllocations.createdAt,
    })
    .from(portAllocations)
    .innerJoin(applications, eq(applications.id, portAllocations.applicationId))
    .where(eq(portAllocations.targetId, targetId))
    .orderBy(asc(portAllocations.port));

  const allocations: PortAllocationView[] = [];
  for (const row of rows) {
    // Le déploiement le plus récent de cette application sur cette cible :
    // c'est lui qui occupe le port réservé.
    const [deployment] = await db
      .select({
        id: deployments.id,
        status: deployments.status,
        url: deployments.url,
      })
      .from(deployments)
      .where(
        and(
          eq(deployments.applicationId, row.applicationId),
          eq(deployments.targetId, targetId),
        ),
      )
      .orderBy(desc(deployments.version))
      .limit(1);

    allocations.push({
      port: row.port,
      applicationId: row.applicationId,
      applicationSlug: row.applicationSlug,
      deploymentId: deployment?.id ?? null,
      deploymentStatus: deployment?.status ?? null,
      url: deployment?.url ?? null,
      reservedAt: row.reservedAt,
    });
  }

  const range: PortRange = { min: target.min, max: target.max };
  const capacity = portRangeSize(range);
  // Une réservation hors plage reste une réservation : la plage a pu être
  // resserrée après coup. Elle compte comme occupée, elle ne compte pas dans la
  // capacité.
  const usedInRange = allocations.filter(
    (allocation) => allocation.port >= range.min && allocation.port <= range.max,
  ).length;

  const taken = new Set(allocations.map((allocation) => allocation.port));
  const freeSample: number[] = [];
  for (let port = range.min; port <= range.max && freeSample.length < FREE_SAMPLE; port += 1) {
    if (!taken.has(port)) freeSample.push(port);
  }

  return {
    targetId: target.id,
    targetName: target.name,
    range,
    capacity,
    used: usedInRange,
    free: Math.max(0, capacity - usedInRange),
    allocations,
    freeSample,
  };
}
