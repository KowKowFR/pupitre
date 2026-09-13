import { z } from 'zod';
import { hostMetricsSchema } from './host-metrics.js';
import { accountMailKindSchema } from './notifications/account-mail.js';
import { notificationDigestSchema } from './notifications/digest.js';
import { notificationMessageSchema } from './notifications/message.js';
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

/**
 * Capture d'écran d'une page supervisée.
 *
 * ── Pourquoi une tâche à part, et pas dans le balayage ──────────────────────
 * Parce qu'**une capture ne doit jamais retarder une alerte**. Le balayage
 * travaille sous un budget de vingt-deux secondes pour deux cents sondes ; une
 * capture coûte deux à dix secondes à elle seule. Rendre cinquante références
 * dans un balayage épuiserait le budget et laisserait des sondes non
 * interrogées — c'est-à-dire qu'une fonctionnalité de confort dégraderait la
 * fonctionnalité principale.
 *
 * Séparée, la capture part **après** que l'incident est écrit et que l'alerte
 * est émise. Elle peut échouer, traîner ou ne jamais tourner : rien de ce qui
 * compte n'en dépend.
 *
 * Sur la file `supervision`, avec les autres lectures : c'est un chargement de
 * page vers l'extérieur, il ne doit ni retarder un déploiement, ni l'attendre.
 * `attempts: 1` — une capture ratée ne se rejoue pas : l'instant qu'elle devait
 * montrer est déjà passé, et une image prise trois minutes après l'incident
 * raconterait autre chose que ce qu'on lui demande.
 */
export const MONITOR_CAPTURE_JOB = 'monitor:capture' as const;

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

/**
 * Deux formes, une union discriminée — parce que ce sont deux demandes qui
 * n'ont ni le même déclencheur ni la même urgence, et qu'un objet unique aux
 * champs à moitié `null` obligerait le handler à deviner laquelle il tient.
 *
 *   incident    « photographie cette sonde maintenant, pour cet incident ».
 *               Enfilée à la transition, une par transition.
 *   references  « rafraîchis les références qui ont vieilli ». Balaie, borné à
 *               quelques sondes par passage. Personne ne l'attend.
 */
export const monitorCaptureJobDataSchema = z.discriminatedUnion('scope', [
  z.object({
    scope: z.literal('incident'),
    monitorId: z.string().uuid(),
    incidentId: z.string().uuid(),
    kind: z.enum(['incident_open', 'incident_resolved']),
  }),
  z.object({
    scope: z.literal('references'),
  }),
]);

export const monitorCaptureJobResultSchema = z.object({
  /** Captures tentées. */
  attempted: z.number().int().nonnegative(),
  /** Captures enregistrées. */
  stored: z.number().int().nonnegative(),
  /** Octets écrits, tous clichés confondus. */
  bytes: z.number().int().nonnegative(),
  /**
   * Motifs des captures qui n'ont pas abouti. Une liste vide n'est pas le cas
   * nominal : un navigateur éteint remplit cette liste, et c'est **normal**.
   */
  skipped: z.array(z.string()),
});

export type MonitorCaptureJobData = z.infer<typeof monitorCaptureJobDataSchema>;
export type MonitorCaptureJobResult = z.infer<typeof monitorCaptureJobResultSchema>;

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
  /**
   * Ce que le regroupement a décidé (ajout du garde-fou de volume) :
   *   immediate  la fenêtre était fermée — le message part tout de suite
   *   held       une fenêtre est ouverte — l'événement est retenu, nommé, en base
   *   skipped    aucun canal abonné : rien à décider
   *
   * `delivered` et `failed` restent à zéro depuis que la remise est une tâche
   * par canal : c'est `notification:deliver` qui les connaît, un canal à la
   * fois. Les champs sont conservés — d'anciens résultats en Redis les portent.
   */
  mode: z.enum(['immediate', 'held', 'skipped']).default('immediate'),
  /** Tâches de remise enfilées, une par canal abonné. */
  queued: z.number().int().nonnegative().default(0),
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
 *
 * **Sauf quand la ressource ne change pas d'une occurrence à l'autre.** C'est
 * le cas des sondes : la ressource est la sonde, la même hier et aujourd'hui.
 * Deux pannes distinctes du même site à moins de cinq minutes d'intervalle se
 * confondaient, et la seconde alerte était avalée sans laisser de trace — un
 * anti-doublon qui perd une alerte est pire que le doublon qu'il évite. Le
 * catalogue fournit alors un discriminant (l'identifiant d'incident), qui
 * sépare les occurrences sans rien changer à l'absorption des rejeux : un rejeu
 * recopie la même charge, donc le même discriminant.
 */
export function notificationDedupKey(
  event: string,
  resourceId: string | null,
  discriminator?: string | null,
): string {
  const base = `${event}|${resourceId ?? 'none'}`;
  return discriminator ? `${base}|${discriminator}` : base;
}

/** Cinq minutes : très au-delà des quelques secondes que durent les rejeux. */
export const NOTIFICATION_DEDUP_TTL_MS = 5 * 60_000;

/* ---------------------------------------------------------------------------
   Notifications — remise par canal et regroupement
   ------------------------------------------------------------------------- */

/**
 * Remise à **un** canal.
 *
 * Second étage de l'éventail : `notification:dispatch` décide *quoi* envoyer et
 * *à qui*, `notification:deliver` envoie, un canal à la fois. Le découpage n'est
 * pas cosmétique — c'est ce qui rend le rejeu correct. Une distribution unique
 * qui échoue sur le serveur SMTP et réussit sur Discord ne peut pas être rejouée
 * sans renvoyer le message à Discord ; c'est la raison pour laquelle la couche
 * livrée hier tenait `attempts: 1`. Une tâche par canal supprime le dilemme :
 * la tâche qui rate est celle d'un seul destinataire, et elle se rejoue seule.
 *
 * L'émetteur, lui, n'a rien changé : c'est toujours le worker qui déplie
 * l'éventail, jamais l'observateur du journal d'audit dans le chemin d'une
 * requête HTTP.
 */
export const NOTIFICATION_DELIVER_JOB = 'notification:deliver' as const;

/**
 * Balayage des fenêtres de regroupement échues.
 *
 * Une tâche répétable, pas une tâche retardée par fenêtre. Une tâche retardée
 * serait plus précise mais vivrait dans Redis, alors que l'état de regroupement
 * vit en base : les deux pourraient diverger, et le jour où Redis est reparti à
 * vide, les fenêtres ouvertes ne se refermeraient plus jamais. Un balayage qui
 * relit la base est, lui, sans état — c'est le même raisonnement que le
 * balayage des sondes de supervision.
 */
export const NOTIFICATION_DIGEST_SWEEP_JOB = 'notification:digest_sweep' as const;

/**
 * Ce qu'une remise transporte : la charge **déjà composée**.
 *
 * Recomposer le message dans la tâche de remise obligerait chaque tentative à
 * relire les paramètres, l'acteur et l'entrée d'audit — et un rejeu trois
 * minutes plus tard pourrait produire un message *différent* de celui reçu par
 * les autres canaux. Un message figé à la composition est le seul qui garantisse
 * que tous les destinataires ont lu la même chose.
 *
 * Aucun secret n'y transite : le message neutre n'en contient pas, et la
 * configuration du canal est relue en base au moment d'envoyer.
 */
export const notificationDeliverJobDataSchema = z.object({
  channelId: z.string().uuid(),
  /** Recopié pour les journaux : un canal supprimé entre-temps n'a plus de nom. */
  channelName: z.string().min(1).max(120),
  payload: z.discriminatedUnion('type', [
    z.object({ type: z.literal('event'), message: notificationMessageSchema }),
    z.object({ type: z.literal('digest'), digest: notificationDigestSchema }),
  ]),
});

export const notificationDeliverJobResultSchema = z.object({
  channelId: z.string().uuid(),
  event: z.string(),
  delivered: z.boolean(),
  /** Numéro de la tentative qui a abouti (ou de la dernière). Commence à 1. */
  attempt: z.number().int().positive(),
  error: z.string().nullable(),
});

export type NotificationDeliverJobData = z.infer<typeof notificationDeliverJobDataSchema>;
export type NotificationDeliverJobResult = z.infer<typeof notificationDeliverJobResultSchema>;

export const notificationDigestSweepJobResultSchema = z.object({
  /** Groupes dont la fenêtre était échue. */
  examined: z.number().int().nonnegative(),
  /** Résumés réellement composés — les fenêtres vides n'en produisent pas. */
  digests: z.number().int().nonnegative(),
  /** Tâches de remise enfilées, tous groupes et tous canaux confondus. */
  queued: z.number().int().nonnegative(),
});

export type NotificationDigestSweepJobResult = z.infer<
  typeof notificationDigestSweepJobResultSchema
>;

/**
 * Rejeu d'une remise.
 *
 * Trois tentatives, espacées exponentiellement à partir de cinq secondes. Le cas
 * visé est le hoquet : un 502 de Discord, un greylisting SMTP, une coupure
 * réseau d'une poignée de secondes. Au-delà, ce n'est plus un hoquet et
 * s'acharner n'apporte rien — l'échec est alors enregistré sur le canal, tracé
 * dans le journal d'audit, et visible à l'écran.
 *
 * La remise est *au moins une fois* : un envoi réussi dont l'accusé se perd
 * partira deux fois. C'est l'arbitrage assumé — un message en double est une
 * gêne, un message d'incident jamais parti est une panne.
 */
export const NOTIFICATION_DELIVER_ATTEMPTS = 3;
export const NOTIFICATION_DELIVER_BACKOFF_MS = 5_000;

/* ---------------------------------------------------------------------------
   Cycle de vie des comptes — e-mails transactionnels
   ------------------------------------------------------------------------- */

/**
 * Invitation ou réinitialisation de mot de passe, par e-mail.
 *
 * Sur la file des notifications, et pas dans la route HTTP qui la déclenche,
 * pour la raison habituelle : le panel n'a **aucun transport SMTP**,
 * `nodemailer` étant délibérément tenu hors de son graphe comme `ssh2`. Il
 * enfile, le worker délivre. Un serveur SMTP lent met une trentaine de secondes
 * à expirer, et personne ne doit attendre cela dans un formulaire.
 *
 * Sur la file `notifications` plutôt qu'`ops` : c'est un envoi d'e-mail, il
 * partage le budget de concurrence des envois d'e-mails, et il ne doit pas
 * attendre derrière un déploiement.
 */
export const ACCOUNT_MAIL_JOB = 'account:mail' as const;

/**
 * Ce qu'un e-mail de compte transporte — et l'unique endroit où la question
 * « où vit le jeton ? » se pose.
 *
 * Le lien porte un jeton de réinitialisation : quiconque l'ouvre prend la main
 * sur le compte. Il traverse donc Redis **chiffré** (AES-256-GCM sous
 * `MASTER_KEY`, le même chiffre que les identifiants SSH des cibles), et pas en
 * clair. Trois raisons, dans l'ordre :
 *
 *   1. Redis est un cache, pas un coffre : il n'est pas chiffré au repos, ses
 *      sauvegardes non plus, et `MONITOR` y montre le contenu des tâches ;
 *   2. une tâche terminée reste en base Redis le temps de sa rétention — bien
 *      plus longtemps que la validité du jeton ;
 *   3. `logAudit()` et Pino ne verront jamais que du texte chiffré si l'un
 *      d'eux journalise une charge de tâche par inadvertance.
 *
 * Le déchiffrement est fait par le worker, juste avant le rendu. C'est
 * exactement la règle appliquée aux secrets des canaux : déchiffrés au dernier
 * moment, par celui qui émet.
 */
export const accountMailJobDataSchema = z.object({
  kind: accountMailKindSchema,
  /** Compte concerné — pour que la trace de remise désigne quelqu'un. */
  userId: z.string().min(1).max(200),
  to: z.string().min(3).max(200),
  recipientName: z.string().min(1).max(120),
  /** Lien d'action **chiffré**. Jamais en clair dans une charge de tâche. */
  encryptedUrl: z.string().min(1).max(4000),
  expiresAt: z.string().datetime(),
  actor: z.string().min(1).max(200).nullable().default(null),
});

export const accountMailJobResultSchema = z.object({
  kind: accountMailKindSchema,
  delivered: z.boolean(),
  /** Nom du canal SMTP emprunté. `null` si aucun n'était disponible. */
  channel: z.string().nullable(),
  /** Déjà expurgé de tout secret par `describeFailure()`. */
  error: z.string().nullable(),
});

export type AccountMailJobData = z.infer<typeof accountMailJobDataSchema>;
export type AccountMailJobResult = z.infer<typeof accountMailJobResultSchema>;

/**
 * Une seule tentative, et pas trois comme pour une remise de notification.
 *
 * Le rejeu vaut pour une alerte — un message d'incident jamais parti est une
 * panne, un doublon est une gêne. Ici c'est l'inverse : la personne est devant
 * son écran, elle voit tout de suite que rien n'est arrivé, et elle redemande.
 * Trois tentatives espacées de cinq secondes ne feraient que tenir un jeton
 * vivant plus longtemps dans une file.
 */
export const ACCOUNT_MAIL_ATTEMPTS = 1;

/* ---------------------------------------------------------------------------
   Déploiements figés
   ------------------------------------------------------------------------- */

/**
 * ## Comment on distingue un fantôme d'un déploiement lent
 *
 * Un déploiement légitime peut tenir plusieurs minutes : un `docker pull` d'une
 * grosse image, un build, un healthcheck qui laisse une application démarrer.
 * Aucun délai ne sépare honnêtement ce cas d'un déploiement dont plus personne
 * ne s'occupe — un détecteur trop pressé conclurait à la mort d'un build de
 * quatre minutes, et rendrait le produit moins fiable que la panne qu'il
 * prétend réparer.
 *
 * Le signal retenu n'est donc pas un délai mais une **preuve d'absence** : la
 * tâche BullMQ qui portait ce déploiement n'existe plus dans aucun état où elle
 * pourrait encore s'exécuter. C'est vérifiable, ce n'est pas une supposition, et
 * c'est exactement ce que BullMQ sait dire.
 *
 * Ce sont les états ci-dessous. Ils sont énumérés **en positif** — « ce qui peut
 * encore tourner » — plutôt qu'en négatif : un état de plus dans une version
 * future de BullMQ serait alors traité comme « peut encore tourner », donc en
 * faveur du déploiement. L'erreur possible penche du bon côté.
 *
 * `completed` et `failed` en sont volontairement absents, et c'est le cœur du
 * sujet : une tâche `failed` **existe encore** dans la file — sept jours, par
 * rétention — sans qu'aucun worker ne la reprenne. C'est précisément l'état où
 * BullMQ abandonne une tâche dont le worker est mort deux fois de suite
 * (« job stalled more than allowable limit ») : elle est mise en échec sans que
 * notre handler ait jamais tourné, donc sans que personne n'écrive le verdict
 * en base. Le déploiement reste `running` pour toujours.
 *
 * Pas d'état « paused » dans cette liste : une file en pause garde ses tâches
 * dans `wait`, la pause est un drapeau sur la file, pas un état de tâche.
 */
export const UNFINISHED_JOB_STATES = [
  'active',
  'wait',
  'waiting-children',
  'delayed',
  'prioritized',
] as const;

export type UnfinishedJobState = (typeof UNFINISHED_JOB_STATES)[number];

/**
 * Fenêtre de grâce avant qu'un déploiement puisse être déclaré fantôme.
 *
 * Ce n'est **pas** un délai de mort : la mort est prouvée par l'absence de
 * tâche, jamais par l'ancienneté. Elle ne couvre qu'une seule fenêtre, celle de
 * l'enfilage : `POST /api/deployments` écrit la ligne en base *puis* enfile la
 * tâche. Entre les deux, un déploiement parfaitement sain n'a effectivement
 * aucune tâche. Une minute est trois ordres de grandeur au-dessus de ce que
 * dure cet intervalle.
 */
export const STUCK_DEPLOYMENT_GRACE_MS = 60_000;

/**
 * Ce qu'on lit d'une tâche de la file pour savoir si elle concerne un
 * déploiement. Volontairement minimal : `@pupitre/core` ne dépend pas de `bullmq` —
 * ce module ne décrit que le contrat des files, il n'en ouvre aucune — et
 * l'appelant, panel ou worker, passe ce qu'il a lu.
 */
export type QueuedJobRef = {
  readonly name: string;
  readonly data: unknown;
};

function readString(data: unknown, key: string): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Cette tâche peut-elle encore faire avancer — ou conclure — ce déploiement ?
 *
 * Les quatre noms retenus sont ceux qui écrivent un statut de déploiement :
 * `deployment:run` le porte de bout en bout, `deployment:rollback` et
 * `deployment:destroy` le concluent, et `application:delete` détruit en cascade
 * tous les déploiements de son application — il ne cite pas de `deploymentId`,
 * d'où la comparaison sur `applicationId`.
 *
 * Le doute profite au déploiement : tant qu'une seule de ces tâches est encore
 * exécutable, on ne déclare rien. Se tromper en attendant coûte une ligne
 * bloquée quelques minutes de plus ; se tromper en concluant écrit un verdict
 * faux sur un déploiement qui, lui, avance encore.
 */
export function jobMayAdvanceDeployment(
  job: QueuedJobRef,
  ref: { deploymentId: string; applicationId: string },
): boolean {
  switch (job.name) {
    case DEPLOYMENT_RUN_JOB:
    case DEPLOYMENT_ROLLBACK_JOB:
    case DEPLOYMENT_DESTROY_JOB:
      return readString(job.data, 'deploymentId') === ref.deploymentId;
    case APPLICATION_DELETE_JOB:
      return readString(job.data, 'applicationId') === ref.applicationId;
    default:
      return false;
  }
}
