import { z } from 'zod';
import { hostMetricsSchema } from './host-metrics.js';
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

/**
 * Suppression en cascade d'une application : détruire ce qui tourne sur les
 * cibles, purger l'historique, rendre les ports, effacer l'application.
 *
 * Sur `ops`, avec les déploiements : c'est le même travail distant, il doit en
 * partager le budget de concurrence. Et par la queue, parce qu'une application
 * déployée sur trois machines, c'est trois sessions SSH — très au-delà de ce
 * qu'une route HTTP a le droit de tenir.
 *
 * Ne se compose pas de `DEPLOYMENT_DESTROY_JOB` enfilés en rafale : le verdict
 * d'ensemble — « qu'est-ce qui n'a pas pu être détruit, et qu'abandonne-t-on
 * alors » — n'appartiendrait à personne. Une tâche, un rapport.
 */
export const APPLICATION_DELETE_JOB = 'application:delete' as const;

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
 * Relevé des métriques d'une machine cible. Sur la file de supervision, pour la
 * même raison que l'inventaire : c'est une lecture, elle ne doit ni retarder un
 * déploiement, ni être retardée par lui. Le panel n'a aucun autre chemin vers
 * une machine distante — `ssh2` est hors de son graphe.
 */
export const TARGET_METRICS_JOB = 'target:metrics' as const;

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

/**
 * Balayage des sondes de supervision de sites.
 *
 * ── Une tâche répétable par sonde, ou un balayage unique ? ───────────────────
 * Le projet a les deux motifs : `scheduled_jobs` installe un repeatable job par
 * ligne, `target:metrics` est une tâche ponctuelle. Ici, **un seul balayage**,
 * et voici pourquoi :
 *
 *   - Un repeatable job par sonde, c'est une réconciliation base ↔ Redis à
 *     chaque création, modification, suspension et suppression. C'est la partie
 *     la plus coûteuse de l'ordonnancement existant, et elle se paierait ici sur
 *     un objet qu'un opérateur crée à la douzaine.
 *   - Un `jobId` BullMQ ne peut pas contenir de deux-points : il faudrait
 *     maltraiter les clés, alors qu'un UUID de sonde tiendrait tel quel.
 *   - La cadence d'une sonde est un nombre de secondes, pas un cron. BullMQ
 *     saurait le faire (`every`), mais le moindre changement d'intervalle
 *     obligerait à réécrire le scheduler — deux vérités qui divergent.
 *   - Surtout : cinquante sondes à trente secondes de délai, c'est vingt-cinq
 *     minutes de travail si on les enchaîne. Le parallélisme et le budget de
 *     temps doivent être décidés **à un seul endroit**, et un balayage est cet
 *     endroit. Cinquante repeatable jobs, eux, se battraient pour les slots de
 *     la file et affameraient les autres lectures.
 *
 * La cadence de la sonde, elle, reste en base : le balayage ne réclame que les
 * sondes dont `next_check_at` est échu.
 *
 * Sur la file `supervision`, avec le reste des lectures : sonder un site ne doit
 * jamais retarder un déploiement, ni attendre qu'il finisse.
 */
export const MONITOR_SWEEP_JOB = 'monitor:sweep' as const;

/**
 * « Sonder maintenant » réutilise `MONITOR_SWEEP_JOB` avec un `monitorId` : un
 * second nom de tâche pour exactement le même travail serait du vocabulaire
 * mort, et un second chemin où la politique SSRF pourrait diverger.
 */

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

/**
 * Suppression en cascade.
 *
 * `force` n'est pas « saute la destruction » mais « efface quand même ce qui
 * n'a pas pu être détruit ». La tentative a lieu dans les deux cas — un forçage
 * qui ne tente rien serait un mauvais outil —, seule la conclusion diffère.
 */
export const applicationDeleteJobDataSchema = z.object({
  applicationId: z.string().uuid(),
  force: z.boolean().default(false),
  actorId: z.string().min(1).nullable().default(null),
  ip: z.string().min(1).nullable().default(null),
});

/** Un déploiement effectivement démonté sur sa cible. */
export const destroyedDeploymentSchema = z.object({
  deploymentId: z.string().uuid(),
  version: z.number().int().positive(),
  targetId: z.string().uuid(),
  targetName: z.string(),
});

/**
 * Ce qu'un forçage abandonne sur une machine, **nommé**.
 *
 * C'est la charge utile qui part dans le journal d'activité, et la seule qui
 * subsistera : une fois l'enregistrement effacé, plus rien dans le panel ne
 * permet de retrouver ces trois informations. Elles sont donc choisies pour
 * qu'un humain puisse finir le ménage à la main sans le panel :
 *   — `targetHost` + `targetName` : sur quelle machine se connecter ;
 *   — `workspace` : le projet Compose (ou namespace) à démonter, `app-{slug}` ;
 *   — `publishedPort` : le port resté promis, à vérifier libre avant réemploi.
 */
export const abandonedWorkloadSchema = z.object({
  deploymentId: z.string().uuid(),
  version: z.number().int().positive(),
  status: z.enum(['pending', 'running', 'success', 'failed', 'rolled_back', 'destroyed']),
  runtime: z.enum(['docker', 'k3s']),
  targetId: z.string().uuid(),
  targetName: z.string(),
  targetHost: z.string(),
  workspace: z.string(),
  publishedPort: z.number().int().nullable(),
  /** Pourquoi la destruction propre a échoué. */
  error: z.string(),
});

export const applicationDeleteJobResultSchema = z.object({
  applicationId: z.string().uuid(),
  applicationSlug: z.string(),
  forced: z.boolean(),
  /** L'application a-t-elle réellement disparu de la base ? */
  deleted: z.boolean(),
  destroyed: z.array(destroyedDeploymentSchema),
  /** Vide quand tout a été détruit proprement. */
  abandoned: z.array(abandonedWorkloadSchema),
  purgedCount: z.number().int().nonnegative(),
  releasedPorts: z.array(
    z.object({ targetId: z.string().uuid(), targetName: z.string(), port: z.number().int() }),
  ),
  /** Une phrase qui dit exactement ce qui a été fait et ce qui ne l'a pas été. */
  summary: z.string(),
});

export type ApplicationDeleteJobData = z.infer<typeof applicationDeleteJobDataSchema>;
export type ApplicationDeleteJobResult = z.infer<typeof applicationDeleteJobResultSchema>;
export type AbandonedWorkload = z.infer<typeof abandonedWorkloadSchema>;
export type DestroyedDeployment = z.infer<typeof destroyedDeploymentSchema>;

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

export const targetMetricsJobDataSchema = z.object({
  targetId: z.string().uuid(),
  actorId: z.string().min(1).nullable().default(null),
  ip: z.string().min(1).nullable().default(null),
});

/**
 * Le relevé lui-même. Une machine injoignable rend un rapport `reachable:false`
 * — pas une tâche en échec : l'écran doit pouvoir dire *pourquoi* il ne sait
 * rien, et continuer d'afficher ce que la base sait de la machine.
 */
export const targetMetricsJobResultSchema = hostMetricsSchema;

export type TargetMetricsJobData = z.infer<typeof targetMetricsJobDataSchema>;
export type TargetMetricsJobResult = z.infer<typeof targetMetricsJobResultSchema>;

export const monitorSweepJobDataSchema = z.object({
  /** Restreint le balayage à une sonde. Sert au déclenchement manuel. */
  monitorId: z.string().uuid().nullable().default(null),
  /** Passe outre `next_check_at` : « sonder maintenant ». */
  force: z.boolean().default(false),
  actorId: z.string().min(1).nullable().default(null),
  ip: z.string().min(1).nullable().default(null),
});

export const monitorSweepJobResultSchema = z.object({
  claimed: z.number().int().nonnegative(),
  probed: z.number().int().nonnegative(),
  healthy: z.number().int().nonnegative(),
  unhealthy: z.number().int().nonnegative(),
  unreachable: z.number().int().nonnegative(),
  opened: z.number().int().nonnegative(),
  resolved: z.number().int().nonnegative(),
  alerts: z.number().int().nonnegative(),
  suspended: z.number().int().nonnegative(),
  pruned: z.number().int().nonnegative(),
  /** Le balayage a rendu la main sur son budget de temps ; le suivant reprendra. */
  budgetExhausted: z.boolean(),
});

export type MonitorSweepJobData = z.infer<typeof monitorSweepJobDataSchema>;
export type MonitorSweepJobResult = z.infer<typeof monitorSweepJobResultSchema>;

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
  [APPLICATION_DELETE_JOB]: ApplicationDeleteJobData;
  [APP_LOGS_JOB]: DeploymentJobData;
  [APP_RESTART_JOB]: DeploymentJobData;
  [WORKLOAD_REMOVE_JOB]: WorkloadActionJobData;
  [WORKLOAD_UPDATE_JOB]: WorkloadActionJobData;
};

export type OpsJobName = keyof OpsJobMap;

/* ---------------------------------------------------------------------------
   Notifications
   ------------------------------------------------------------------------- */

/**
 * File dédiée aux notifications.
 *
 * Ni `ops`, ni `supervision`, et ce n'est pas de la coquetterie :
 *
 *   — sur `ops`, une alerte « déploiement en échec » attendrait derrière les
 *     déploiements en cours. Prévenir tard revient à ne pas prévenir ;
 *   — sur `supervision`, elle attendrait derrière les suivis de logs, qui
 *     tiennent leur slot pendant toute la consultation — jusqu'à trente
 *     minutes. Huit onglets ouverts suffiraient à museler les alertes.
 *
 * Le raisonnement est exactement celui qui a justifié `supervision` en son
 * temps : deux budgets de concurrence, aucune famine possible.
 */
export const NOTIFICATIONS_QUEUE = 'notifications' as const;

/**
 * Distribution d'un événement notifiable vers les canaux qui y sont abonnés.
 *
 * Une tâche **par événement**, pas par canal : l'éventail se déploie dans le
 * worker, qui lit en une fois les canaux abonnés. Enfiler par canal obligerait
 * l'émetteur — c'est-à-dire l'observateur du journal d'audit, dans le chemin
 * d'une requête HTTP — à interroger la base avant de rendre la main.
 */
export const NOTIFICATION_DISPATCH_JOB = 'notification:dispatch' as const;

/** Essai manuel d'un canal, déclenché depuis l'écran des paramètres. */
export const NOTIFICATION_TEST_JOB = 'notification:test' as const;

/**
 * L'entrée d'audit à l'origine de l'événement, recopiée telle quelle.
 *
 * Le message neutre n'est **pas** composé ici mais dans le worker : sa
 * composition demande le nom de l'instance, l'URL du panel et l'e-mail de
 * l'acteur, soit trois lectures que l'émetteur n'a pas à faire dans le chemin
 * d'une requête.
 */
export const notificationDispatchJobDataSchema = z.object({
  event: z.string().min(1).max(80),
  auditLogId: z.string().uuid().nullable().default(null),
  occurredAt: z.string().datetime(),
  entry: z.object({
    action: z.string().min(1).max(120),
    resourceType: z.string().min(1).max(60),
    resourceId: z.string().max(200).nullable().default(null),
    actorId: z.string().max(200).nullable().default(null),
    before: z.unknown().nullable().default(null),
    after: z.unknown().nullable().default(null),
  }),
});

export const notificationDispatchJobResultSchema = z.object({
  event: z.string(),
  /** Canaux abonnés et actifs au moment de la distribution. */
  targeted: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export type NotificationDispatchJobData = z.infer<typeof notificationDispatchJobDataSchema>;
export type NotificationDispatchJobResult = z.infer<typeof notificationDispatchJobResultSchema>;

export const notificationTestJobDataSchema = z.object({
  channelId: z.string().uuid(),
  actorId: z.string().min(1).nullable().default(null),
  ip: z.string().min(1).nullable().default(null),
});

/**
 * Le verdict d'un essai. `probe` est le résultat de `test()` — la vérification
 * qui ne délivre rien —, `delivered` celui de l'envoi réel. Les deux sont
 * rapportés séparément parce qu'ils échouent pour des raisons différentes : un
 * jeton valide dont l'identifiant de conversation est faux passe la première et
 * rate la seconde.
 */
export const notificationTestJobResultSchema = z.object({
  channelId: z.string().uuid(),
  kind: z.string(),
  probe: z.object({ ok: z.boolean(), detail: z.string() }),
  delivered: z.boolean(),
  error: z.string().nullable(),
});

export type NotificationTestJobData = z.infer<typeof notificationTestJobDataSchema>;
export type NotificationTestJobResult = z.infer<typeof notificationTestJobResultSchema>;

/**
 * Clé d'anti-doublon d'une distribution.
 *
 * Motif réel : une tâche de déploiement interrompue hors pipeline est rejouée
 * jusqu'à trois fois par BullMQ, et **chaque tentative écrit sa propre entrée
 * `deployment.failed`**. Sans cette clé, un incident produirait trois e-mails
 * identiques à quelques secondes d'intervalle.
 *
 * La fenêtre porte sur le couple (événement, ressource) : deux déploiements
 * différents ont des identifiants différents et ne se masquent pas.
 */
export function notificationDedupKey(event: string, resourceId: string | null): string {
  return `${event}|${resourceId ?? 'none'}`;
}

/** Cinq minutes : très au-delà des quelques secondes que durent les rejeux. */
export const NOTIFICATION_DEDUP_TTL_MS = 5 * 60_000;
