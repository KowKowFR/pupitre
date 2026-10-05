import { z } from 'zod';

/**
 * Host metrics — what the machine does, not what it carries.
 *
 * **Why it is not in the `DeploymentDriver`.** Load, memory, disk, uptime,
 * kernel: none of this depends on the runtime. A Linux machine is a Linux
 * machine, whether it carries Docker or K3s; `/proc/loadavg` knows neither.
 * Putting them in the drivers would force writing them twice and maintaining
 * them twice, for a result that must be identical on both sides. Their place is
 * next to the preflight, which already inspects the host the same way — hence
 * this file's symmetry with `preflight.ts`: the *types* here, the SSH probe in
 * `ssh/host-metrics.ts`, so that the Next panel can read the former without
 * pulling `ssh2` into its graph.
 *
 * **`null` means "I don't know".** No metric has a fallback value: a zero shown
 * instead of an unmeasured disk would suggest an empty disk, and 100% a full
 * disk. Each reading is independent — a missing `nproc` leaves the load
 * readable, it does not fail the rest.
 */

/** An elementary reading, and what it cost. Mirror of `PreflightCheck`. */
export const hostProbeSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(['success', 'failed']),
  durationMs: z.number().int().nonnegative(),
  detail: z.string().nullable(),
  error: z.string().nullable(),
});
export type HostProbe = z.infer<typeof hostProbeSchema>;

/**
 * Load average, relative to the number of cores.
 *
 * A load of 4 says nothing until we know on how many cores: it is comfortable on
 * 16, it is twice the capacity on 2. `perCore` is the only value really
 * comparable from one machine to another — it stays `null` when `nproc` is
 * missing, rather than assuming one core.
 */
export const hostLoadSchema = z.object({
  one: z.number().nonnegative(),
  five: z.number().nonnegative(),
  fifteen: z.number().nonnegative(),
  cores: z.number().int().positive().nullable(),
  /** `one / cores`, or `null` if the number of cores is unknown. */
  perCore: z.number().nonnegative().nullable(),
});
export type HostLoad = z.infer<typeof hostLoadSchema>;

/**
 * Memory, in kibibytes as `/proc/meminfo` gives them.
 *
 * `MemAvailable` and not `MemFree`: under Linux, "free" memory is wasted memory
 * — the page cache takes it and gives it back to the first requester. A panel
 * that showed `MemFree` would announce a saturated machine on a perfectly
 * comfortable server.
 */
export const hostMemorySchema = z.object({
  totalKb: z.number().int().nonnegative(),
  availableKb: z.number().int().nonnegative(),
  usedKb: z.number().int().nonnegative(),
  usedPercent: z.number().min(0).max(100),
});
export type HostMemory = z.infer<typeof hostMemorySchema>;

/**
 * Disk of the partition that **carries the deployments**, not `/`.
 *
 * On a machine where `/opt` is a separate volume, measuring `/` would miss the
 * question: it is the partition the driver writes on that decides whether a
 * deployment goes through. `path` says what was really measured.
 */
export const hostDiskSchema = z.object({
  /** Path actually measured — the existing ancestor closest to the driver's root. */
  path: z.string().min(1),
  filesystem: z.string().min(1),
  sizeKb: z.number().int().nonnegative(),
  usedKb: z.number().int().nonnegative(),
  availableKb: z.number().int().nonnegative(),
  usePercent: z.number().min(0).max(100),
  mountedOn: z.string().min(1),
});
export type HostDisk = z.infer<typeof hostDiskSchema>;

/** The system's identity. Each field is independently unknown. */
export const hostOsSchema = z.object({
  kernel: z.string().nullable(),
  name: z.string().nullable(),
  version: z.string().nullable(),
  prettyName: z.string().nullable(),
});
export type HostOs = z.infer<typeof hostOsSchema>;

/**
 * A complete reading, true at the second it is taken.
 *
 * It is not stored: it travels through the job's return value. Putting it in the
 * database would take a table, a migration and a freshness policy for data that
 * has no history — the load of an hour ago teaches nobody anything.
 */
export const hostMetricsSchema = z.object({
  targetId: z.string().uuid(),
  checkedAt: z.string(),
  reachable: z.boolean(),
  /** Time to establish the SSH session. `null` if it did not succeed. */
  latencyMs: z.number().int().nonnegative().nullable(),
  /** Filled in only when the machine is unreachable. */
  error: z.string().nullable(),
  load: hostLoadSchema.nullable(),
  memory: hostMemorySchema.nullable(),
  disk: hostDiskSchema.nullable(),
  uptimeSeconds: z.number().nonnegative().nullable(),
  os: hostOsSchema,
  probes: z.array(hostProbeSchema),
});
export type HostMetrics = z.infer<typeof hostMetricsSchema>;

/** The reading of a machine that could not be reached. No metric, a reason. */
export function unreachableHostMetrics(
  targetId: string,
  error: string,
  checkedAt = new Date().toISOString(),
  probes: HostProbe[] = [],
): HostMetrics {
  return {
    targetId,
    checkedAt,
    reachable: false,
    latencyMs: null,
    error,
    load: null,
    memory: null,
    disk: null,
    uptimeSeconds: null,
    os: { kernel: null, name: null, version: null, prettyName: null },
    probes,
  };
}
