import { z } from 'zod';
import { workloadActionSchema, workloadListSchema, workloadRefSchema } from './workloads.js';

/**
 * Contrat partagé entre `apps/web` (producteur) et `apps/worker` (consommateur).
 * Toute opération longue passe par ici — jamais dans une route HTTP.
 */

export const OPS_QUEUE = 'ops' as const;

/**
 * File dédiée à la supervision.
 *
 * Un flux de logs tient son slot tant qu'un spectateur regarde — jusqu'à trente
 * minutes. Le laisser dans `ops` reviendrait à ce que quatre onglets ouverts
 * empêchent tout déploiement. Deux files, deux budgets de concurrence, aucune
 * famine possible.
 */
export const SUPERVISION_QUEUE = 'supervision' as const;

export const PING_JOB = 'ping' as const;

export const TARGET_PREFLIGHT_JOB = 'target:preflight' as const;

export const DEPLOYMENT_RUN_JOB = 'deployment:run' as const;
export const DEPLOYMENT_ROLLBACK_JOB = 'deployment:rollback' as const;
export const DEPLOYMENT_DESTROY_JOB = 'deployment:destroy' as const;

/** Suivi des logs applicatifs. Tient une session SSH tant qu'un spectateur écoute. */
export const APP_LOGS_JOB = 'app:logs' as const;
/** Redémarrage d'une application en marche. */
export const APP_RESTART_JOB = 'app:restart' as const;

/**
 * Inventaire des charges d'une cible. Sur la file de supervision, comme le
 * suivi de logs : c'est une lecture, elle ne doit jamais retarder un
 * déploiement, ni être retardée par lui.
 */
export const WORKLOAD_LIST_JOB = 'workload:list' as const;

/**
 * Suppression et mise à jour d'une charge. Sur `ops` : ce sont des écritures
 * sur la machine, du même ordre qu'un déploiement, et elles doivent en partager
 * la discipline de concurrence.
 *
 * Ces deux tâches sont toujours enfilées avec `attempts: 1` : rejouer une
 * suppression n'a aucun sens, et rejouer une mise à jour recréerait une charge
 * déjà recréée.
 */
export const WORKLOAD_REMOVE_JOB = 'workload:remove' as const;
export const WORKLOAD_UPDATE_JOB = 'workload:update' as const;

export const pingJobDataSchema = z.object({
  message: z.string().min(1).max(280).default('pong'),
  requestedAt: z.string().datetime(),
  /** Renseigné dès le jalon 2, quand l'authentification existe. */
  actorId: z.string().min(1).nullable().default(null),
  ip: z.string().min(1).nullable().default(null),
});

export const pingJobResultSchema = z.object({
  ok: z.literal(true),
  message: z.string(),
  handledAt: z.string().datetime(),
  /** `null` si l'écriture d'audit a échoué — cela ne fait pas échouer la tâche. */
  auditLogId: z.string().uuid().nullable(),
  workerId: z.string(),
});

export type PingJobData = z.infer<typeof pingJobDataSchema>;
export type PingJobResult = z.infer<typeof pingJobResultSchema>;

export const targetPreflightJobDataSchema = z.object({
  targetId: z.string().uuid(),
  /** Utilisateur à l'origine de la demande. `null` pour un déclenchement planifié. */
  actorId: z.string().min(1).nullable().default(null),
  ip: z.string().min(1).nullable().default(null),
});

export const targetPreflightJobResultSchema = z.object({
  targetId: z.string().uuid(),
  status: z.enum(['unknown', 'ok', 'degraded', 'unreachable']),
  reachable: z.boolean(),
  runtimes: z.array(z.enum(['docker', 'k3s'])),
  checkedAt: z.string(),
});

export type TargetPreflightJobData = z.infer<typeof targetPreflightJobDataSchema>;
export type TargetPreflightJobResult = z.infer<typeof targetPreflightJobResultSchema>;

export const deploymentJobDataSchema = z.object({
  deploymentId: z.string().uuid(),
  actorId: z.string().min(1).nullable().default(null),
  ip: z.string().min(1).nullable().default(null),
});

export const deploymentJobResultSchema = z.object({
  deploymentId: z.string().uuid(),
  status: z.enum(['success', 'failed', 'rolled_back', 'destroyed']),
  url: z.string().nullable(),
  failedStep: z.string().nullable(),
});

export type DeploymentJobData = z.infer<typeof deploymentJobDataSchema>;
export type DeploymentJobResult = z.infer<typeof deploymentJobResultSchema>;

export const workloadListJobDataSchema = z.object({
  targetId: z.string().uuid(),
  actorId: z.string().min(1).nullable().default(null),
  ip: z.string().min(1).nullable().default(null),
});

export const workloadListJobResultSchema = workloadListSchema;

export const workloadActionJobDataSchema = z.object({
  targetId: z.string().uuid(),
  ref: workloadRefSchema,
  action: workloadActionSchema,
  /**
   * Nom de la charge tel que l'appelant l'a vu au moment de décider. Il sert au
   * journal d'audit et aux messages : une charge supprimée n'a plus de nom à
   * aller chercher après coup.
   */
  name: z.string().min(1).max(300),
  actorId: z.string().min(1).nullable().default(null),
  ip: z.string().min(1).nullable().default(null),
});

export const workloadActionJobResultSchema = z.object({
  targetId: z.string().uuid(),
  ref: z.string(),
  action: workloadActionSchema,
  ok: z.literal(true),
  lines: z.number().int().nonnegative(),
});

export type WorkloadListJobData = z.infer<typeof workloadListJobDataSchema>;
export type WorkloadListJobResult = z.infer<typeof workloadListJobResultSchema>;
export type WorkloadActionJobData = z.infer<typeof workloadActionJobDataSchema>;
export type WorkloadActionJobResult = z.infer<typeof workloadActionJobResultSchema>;

/** Toutes les tâches acceptées par la queue `ops`. */
export type OpsJobMap = {
  [PING_JOB]: PingJobData;
  [TARGET_PREFLIGHT_JOB]: TargetPreflightJobData;
  [DEPLOYMENT_RUN_JOB]: DeploymentJobData;
  [DEPLOYMENT_ROLLBACK_JOB]: DeploymentJobData;
  [DEPLOYMENT_DESTROY_JOB]: DeploymentJobData;
  [APP_LOGS_JOB]: DeploymentJobData;
  [APP_RESTART_JOB]: DeploymentJobData;
  [WORKLOAD_REMOVE_JOB]: WorkloadActionJobData;
  [WORKLOAD_UPDATE_JOB]: WorkloadActionJobData;
};

export type OpsJobName = keyof OpsJobMap;
