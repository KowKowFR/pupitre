import { z } from 'zod';

/**
 * Shapes of the preflight report.
 *
 * This file depends on no SSH brick: the panel imports it to show a report,
 * without ever pulling `ssh2` into its dependency graph. The execution lives in
 * `@pupitre/core/ssh`.
 */

export const checkStatusSchema = z.enum(['success', 'failed', 'skipped']);
export type CheckStatus = z.infer<typeof checkStatusSchema>;

/** An independent check. Its failure does not invalidate the others. */
export const preflightCheckSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  status: checkStatusSchema,
  durationMs: z.number().int().min(0),
  detail: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
});

export const dockerRuntimeSchema = z.object({
  available: z.boolean(),
  version: z.string().nullable().default(null),
  composeVersion: z.string().nullable().default(null),
});

export const k3sRuntimeSchema = z.object({
  available: z.boolean(),
  version: z.string().nullable().default(null),
  nodes: z.number().int().min(0).nullable().default(null),
  readyNodes: z.number().int().min(0).nullable().default(null),
  clusterReady: z.boolean().default(false),
});

/**
 * Content of `targets.runtimes_available`.
 * Structured and not a mere array: the driver needs the versions, not only the
 * availability.
 */
export const runtimesAvailableSchema = z.object({
  docker: dockerRuntimeSchema,
  k3s: k3sRuntimeSchema,
});

export const osInfoSchema = z.object({
  uname: z.string().nullable().default(null),
  name: z.string().nullable().default(null),
  version: z.string().nullable().default(null),
  prettyName: z.string().nullable().default(null),
});

export const sudoInfoSchema = z.object({
  available: z.boolean(),
  nopasswd: z.boolean(),
});

export const diskInfoSchema = z.object({
  filesystem: z.string(),
  sizeKb: z.number().int().min(0),
  usedKb: z.number().int().min(0),
  availableKb: z.number().int().min(0),
  usePercent: z.number().int().min(0).max(100),
  mountedOn: z.string(),
});

export const memoryInfoSchema = z.object({
  totalMb: z.number().int().min(0),
  usedMb: z.number().int().min(0),
  freeMb: z.number().int().min(0),
  availableMb: z.number().int().min(0),
});

export const toolsSchema = z.object({
  ufw: z.boolean(),
  curl: z.boolean(),
  git: z.boolean(),
  docker: z.boolean(),
  kubectl: z.boolean(),
});

/**
 * The target's firewall state.
 *
 * `installed` without `active` is the common case: ufw is there, it was never
 * enabled. The panel does not enable it on its own initiative — cutting off the
 * firewall of a machine driven over SSH is an excellent way to lose the machine.
 * It reports it, and that is all.
 */
export const firewallSchema = z.object({
  installed: z.boolean(),
  active: z.boolean(),
  /** Open ports carrying the panel's marker (`pupitre:{slug}`, or the old one). */
  managedRules: z.array(z.string()).default([]),
});

/** A target's overall status after preflight. */
export const targetHealthSchema = z.enum(['unknown', 'ok', 'degraded', 'unreachable']);
export type TargetHealth = z.infer<typeof targetHealthSchema>;

/** Content of `targets.preflight_report`. */
export const preflightReportSchema = z.object({
  checkedAt: z.string(),
  reachable: z.boolean(),
  status: targetHealthSchema,
  /** Time to establish the SSH session. */
  latencyMs: z.number().int().min(0).nullable().default(null),
  os: osInfoSchema,
  sudo: sudoInfoSchema,
  disk: diskInfoSchema.nullable().default(null),
  memory: memoryInfoSchema.nullable().default(null),
  tools: toolsSchema,
  /**
   * Added afterwards. `null` for earlier reports: a report already in the
   * database is not rewritten, the UI simply says "unknown".
   */
  firewall: firewallSchema.nullable().default(null),
  runtimes: runtimesAvailableSchema,
  checks: z.array(preflightCheckSchema),
  /** Overall failure message, when the target could not be reached. */
  error: z.string().nullable().default(null),
});

export type PreflightCheck = z.infer<typeof preflightCheckSchema>;
export type DockerRuntime = z.infer<typeof dockerRuntimeSchema>;
export type K3sRuntime = z.infer<typeof k3sRuntimeSchema>;
export type RuntimesAvailable = z.infer<typeof runtimesAvailableSchema>;
export type OsInfo = z.infer<typeof osInfoSchema>;
export type SudoInfo = z.infer<typeof sudoInfoSchema>;
export type DiskInfo = z.infer<typeof diskInfoSchema>;
export type MemoryInfo = z.infer<typeof memoryInfoSchema>;
export type Tools = z.infer<typeof toolsSchema>;
export type FirewallInfo = z.infer<typeof firewallSchema>;
export type PreflightReport = z.infer<typeof preflightReportSchema>;

export const EMPTY_RUNTIMES: RuntimesAvailable = {
  docker: { available: false, version: null, composeVersion: null },
  k3s: { available: false, version: null, nodes: null, readyNodes: null, clusterReady: false },
};

/** Runtimes really usable for a deployment. */
export function usableRuntimes(runtimes: RuntimesAvailable): Array<'docker' | 'k3s'> {
  const usable: Array<'docker' | 'k3s'> = [];
  if (runtimes.docker.available) usable.push('docker');
  if (runtimes.k3s.available && runtimes.k3s.clusterReady) usable.push('k3s');
  return usable;
}
