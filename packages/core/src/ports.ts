/**
 * Reserving public ports on a target.
 *
 * The interface lives here, at the root of `@pupitre/core`, and not in
 * `drivers/`: its implementation is in the database (`packages/db`), which has
 * no reason to pull `ssh2` into its type graph.
 *
 * Collision avoidance is a unique `(target_id, port)` constraint, never an `if`
 * in TypeScript. The driver asks, the database decides.
 */

export const PORT_RANGE_MIN = 30_000;
export const PORT_RANGE_MAX = 32_767;

export type PortAllocationRequest = {
  targetId: string;
  applicationId: string;
  min: number;
  max: number;
  /**
   * Ports to leave out of the draw, on top of those already reserved in the
   * database.
   *
   * Used for what is observed on the target: a port can be taken by a service
   * that does not belong to the panel, and the database knows nothing about it.
   * The caller then runs `allocate()` again excluding what it just saw taken.
   */
  exclude?: readonly number[];
};

export type PortAllocationKey = {
  targetId: string;
  applicationId: string;
};

export type PortAllocator = {
  /**
   * Reserves a free port in `[min, max]`. Retries on a uniqueness conflict.
   * Returns the port already reserved if the application has one.
   */
  allocate: (request: PortAllocationRequest) => Promise<number>;
  /** Releases the reservation. Idempotent. */
  release: (key: PortAllocationKey) => Promise<void>;
  /** Port already reserved, or `null`. */
  current: (key: PortAllocationKey) => Promise<number | null>;
};

/** Range of publishable ports, as a target carries it. */
export type PortRange = { min: number; max: number };

export const DEFAULT_PORT_RANGE: PortRange = { min: PORT_RANGE_MIN, max: PORT_RANGE_MAX };

/**
 * Intersection of two ranges.
 *
 * A target declares its own (`targets.port_range_start/end`); the worker can
 * impose a narrower one globally (`DRIVER_PORT_RANGE`), typically when it is the
 * host that only publishes part of it. Both constraints are real: we keep their
 * intersection, not the last one read.
 * Returns `null` if they do not overlap — a case to report, not to hide.
 */
export function intersectPortRanges(a: PortRange, b: PortRange | undefined): PortRange | null {
  if (!b) return a;
  const min = Math.max(a.min, b.min);
  const max = Math.min(a.max, b.max);
  return min <= max ? { min, max } : null;
}

/** Number of ports in a range, bounds included. */
export function portRangeSize(range: PortRange): number {
  return Math.max(0, range.max - range.min + 1);
}

/** No free port in the requested range. */
export class PortExhaustedError extends Error {
  constructor(
    readonly targetId: string,
    readonly min: number,
    readonly max: number,
  ) {
    super(`No free port between ${min} and ${max} on target ${targetId}`);
    this.name = 'PortExhaustedError';
  }
}
