import { z } from 'zod';

/**
 * Formes du rapport de preflight.
 *
 * Ce fichier ne dépend d'aucune brique SSH : le panel l'importe pour afficher
 * un rapport, sans jamais tirer `ssh2` dans son graphe de dépendances.
 * L'exécution vit dans `@pupitre/core/ssh`.
 */

export const checkStatusSchema = z.enum(['success', 'failed', 'skipped']);
export type CheckStatus = z.infer<typeof checkStatusSchema>;

/** Un contrôle indépendant. Son échec n'invalide pas les autres. */
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
 * Contenu de `targets.runtimes_available`.
 * Structuré et non un simple tableau : le driver a besoin des
 * versions, pas seulement de la disponibilité.
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
 * État du pare-feu de la cible.
 *
 * `installed` sans `active` est le cas courant : ufw est là, il n'a jamais été
 * activé. Le panel ne l'active pas de son propre chef — couper le pare-feu
 * d'une machine qu'on pilote en SSH est un excellent moyen de perdre la
 * machine. Il le signale, et c'est tout.
 */
export const firewallSchema = z.object({
  installed: z.boolean(),
  active: z.boolean(),
  /** Ports ouverts portant le marqueur du panel (`pupitre:{slug}`, ou l'ancien). */
  managedRules: z.array(z.string()).default([]),
});

/** Statut global d'une cible après preflight. */
export const targetHealthSchema = z.enum(['unknown', 'ok', 'degraded', 'unreachable']);
export type TargetHealth = z.infer<typeof targetHealthSchema>;

/** Contenu de `targets.preflight_report`. */
export const preflightReportSchema = z.object({
  checkedAt: z.string(),
  reachable: z.boolean(),
  status: targetHealthSchema,
  /** Temps d'établissement de la session SSH. */
  latencyMs: z.number().int().min(0).nullable().default(null),
  os: osInfoSchema,
  sudo: sudoInfoSchema,
  disk: diskInfoSchema.nullable().default(null),
  memory: memoryInfoSchema.nullable().default(null),
  tools: toolsSchema,
  /**
   * Ajouté après coup. `null` pour les rapports antérieurs : un rapport déjà
   * en base ne se réécrit pas, l'UI dit simplement « inconnu ».
   */
  firewall: firewallSchema.nullable().default(null),
  runtimes: runtimesAvailableSchema,
  checks: z.array(preflightCheckSchema),
  /** Message d'échec global, quand la cible n'a pas pu être jointe. */
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

/** Runtimes réellement utilisables pour un déploiement. */
export function usableRuntimes(runtimes: RuntimesAvailable): Array<'docker' | 'k3s'> {
  const usable: Array<'docker' | 'k3s'> = [];
  if (runtimes.docker.available) usable.push('docker');
  if (runtimes.k3s.available && runtimes.k3s.clusterReady) usable.push('k3s');
  return usable;
}
