import {
  PortExhaustedError,
  portRangeSize,
  type PortAllocationKey,
  type PortAllocationRequest,
  type PortAllocator,
  type PortRange,
} from '@pupitre/core';
import { and, asc, desc, eq } from 'drizzle-orm';
import { getDb, type Database } from './client.js';
import { deployments, portAllocations } from './schema/deployments.js';
import { applications, targets } from './schema/infra.js';

/**
 * Implementation of `PortAllocator` backed by `port_allocations`.
 *
 * Uniqueness comes from the `(target_id, port)` constraint, not from a test in
 * TypeScript: two workers aiming at the same port at the same instant produce a
 * `23505` violation, and the loser retries. The database decides.
 */

/** Uniqueness constraint violation on the PostgreSQL side. */
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
      // Read again at each attempt: another transaction may have reserved meanwhile.
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
        // `excluded`: ports the caller observed taken on the machine itself. The
        // database cannot know it — it only knows the panel's reservations.
        if (!taken.has(port) && !excluded.has(port)) free.push(port);
      }
      if (free.length === 0) {
        throw new PortExhaustedError(request.targetId, request.min, request.max);
      }

      // Random draw: two simultaneous workers do not aim at the same port, which
      // makes collision rare rather than systematic.
      const candidate = free[Math.floor(Math.random() * free.length)];
      if (candidate === undefined) continue;

      try {
        // A transaction for the write: the INSERT *is* the uniqueness test. A SELECT
        // followed by an INSERT would leave a window between the two, and it is exactly
        // the window two simultaneous workers would find.
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
          // Someone took this port — or this application just got one through another
          // transaction. We read again before retrying.
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
 * An application's reservations, all targets together.
 *
 * `port_allocations` is indexed by (target, application) and not by deployment:
 * it is therefore **here** that we read what a deletion will give back, and not
 * by adding up the deployments' `published_port` — a pair can hold a
 * reservation without any deployment having succeeded.
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

// ─── overview ─────────────────────────────────────────────────────────────────

/** A reservation, as the API and the UI present it. */
export type PortAllocationView = {
  port: number;
  applicationId: string;
  applicationSlug: string;
  /** This application's last deployment on this target, if it exists. */
  deploymentId: string | null;
  deploymentStatus: string | null;
  url: string | null;
  reservedAt: Date;
};

export type TargetPortReport = {
  targetId: string;
  targetName: string;
  range: PortRange;
  /** The range's ports, all uses together. */
  capacity: number;
  used: number;
  free: number;
  allocations: PortAllocationView[];
  /**
   * First free ports, as an indication. The list is truncated: showing the 2,768
   * free ports of a default range would teach nothing.
   */
  freeSample: number[];
};

const FREE_SAMPLE = 20;

/**
 * A target's port allocation state.
 *
 * The range comes from the target itself: it is the one that knows what its
 * firewall lets through.
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
    // This application's most recent deployment on this target: it is the one
    // occupying the reserved port.
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
  // A reservation outside the range is still a reservation: the range may have
  // been narrowed afterwards. It counts as taken, it does not count in the
  // capacity.
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
