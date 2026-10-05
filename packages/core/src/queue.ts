import { z } from 'zod';
import { backupTriggerSchema } from './backup/model.js';
import { acmeSettingsSchema } from './proxy/model.js';
import { hostMetricsSchema } from './host-metrics.js';
import { accountMailKindSchema } from './notifications/account-mail.js';
import { notificationDigestSchema } from './notifications/digest.js';
import { notificationMessageSchema } from './notifications/message.js';
import {
  WORKLOAD_EXEC_MAX_COMMAND,
  WORKLOAD_LOGS_MAX_TAIL,
  workloadActionSchema,
  workloadControlActionSchema,
  workloadListSchema,
  workloadRefSchema,
} from './workloads.js';

/**
 * Contract shared between `apps/web` (producer) and `apps/worker` (consumer).
 * Every long-running operation goes through here — never in an HTTP route.
 */

export const OPS_QUEUE = 'ops' as const;

/**
 * Queue dedicated to monitoring.
 *
 * A log stream holds its slot as long as a viewer is watching — up to thirty
 * minutes. Leaving it in `ops` would mean four open tabs could prevent every
 * deployment. Two queues, two concurrency budgets, no possible starvation.
 */
export const SUPERVISION_QUEUE = 'supervision' as const;

export const PING_JOB = 'ping' as const;

export const TARGET_PREFLIGHT_JOB = 'target:preflight' as const;

export const DEPLOYMENT_RUN_JOB = 'deployment:run' as const;
export const DEPLOYMENT_ROLLBACK_JOB = 'deployment:rollback' as const;
export const DEPLOYMENT_DESTROY_JOB = 'deployment:destroy' as const;

/**
 * Cascading deletion of an application: destroy what runs on the targets, purge
 * the history, release the ports, delete the application.
 *
 * On `ops`, with the deployments: it is the same remote work, it must share
 * their concurrency budget. And through the queue, because an application
 * deployed on three machines means three SSH sessions — far beyond what an HTTP
 * route is allowed to hold.
 *
 * It is not made of `DEPLOYMENT_DESTROY_JOB`s enqueued in a burst: the overall
 * verdict — "what could not be destroyed, and what do we abandon then" — would
 * belong to nobody. One task, one report.
 */
export const APPLICATION_DELETE_JOB = 'application:delete' as const;

/** Following application logs. Holds an SSH session as long as a viewer listens. */
export const APP_LOGS_JOB = 'app:logs' as const;
/** Restarting a running application. */
export const APP_RESTART_JOB = 'app:restart' as const;
/**
 * Stopping and starting a deployed application.
 *
 * On the monitoring queue, with the restart: they are the same operations
 * gestures on an application already in place, they replay no pipeline and do
 * not compete for the deployments' slots.
 *
 * Two task names rather than one with an `action` field: a worker of an earlier
 * version that receives an unknown name fails outright, whereas it would have
 * ignored an extra field — zod strips keys it does not know — and **restarted**
 * an application it was asked to stop. The task name is the only part of the
 * message a consumer cannot misinterpret.
 */
export const APP_STOP_JOB = 'app:stop' as const;
export const APP_START_JOB = 'app:start' as const;

/**
 * Inventory of a target's workloads. On the monitoring queue, like log
 * following: it is a read, it must never delay a deployment, nor be delayed by
 * one.
 */
export const WORKLOAD_LIST_JOB = 'workload:list' as const;

/**
 * Reading of a target machine's metrics. On the monitoring queue, for the same
 * reason as the inventory: it is a read, it must neither delay a deployment nor
 * be delayed by one. The panel has no other path to a remote machine — `ssh2`
 * is outside its graph.
 */
export const TARGET_METRICS_JOB = 'target:metrics' as const;

/**
 * A domain's inspection for its drawer: DNS, RDAP, certificate. On the
 * monitoring queue: a few seconds of network, a read the panel waits for and
 * that a deployment must not delay.
 */
export const DOMAIN_INSPECT_JOB = 'domain:inspect' as const;

/**
 * Deleting and updating a workload. On `ops`: they are writes on the machine,
 * of the same order as a deployment, and they must share its concurrency
 * discipline.
 *
 * Both tasks are always enqueued with `attempts: 1`: replaying a deletion makes
 * no sense, and replaying an update would recreate a workload already
 * recreated.
 */
export const WORKLOAD_REMOVE_JOB = 'workload:remove' as const;
export const WORKLOAD_UPDATE_JOB = 'workload:update' as const;

/**
 * Starting, stopping, restarting a workload; running a command in it. On
 * `ops`, like the deletion: they are writes on the machine.
 */
export const WORKLOAD_CONTROL_JOB = 'workload:control' as const;
export const WORKLOAD_EXEC_JOB = 'workload:exec' as const;

/**
 * The last lines of a workload's log. On `supervision`: it is a read, it must
 * not wait behind a deployment.
 */
export const WORKLOAD_LOGS_JOB = 'workload:logs' as const;

/**
 * Sweep of the website monitoring probes.
 *
 * ── One repeatable task per probe, or a single sweep? ──────────────────────
 * The project has both patterns: `scheduled_jobs` installs one repeatable job
 * per row, `target:metrics` is a one-off task. Here, **a single sweep**, and
 * here is why:
 *
 *   - One repeatable job per probe means a database ↔ Redis reconciliation at
 *     each creation, edit, pause and deletion. It is the most expensive part of
 *     the existing scheduling, and it would be paid here on an object an
 *     operator creates by the dozen.
 *   - A BullMQ `jobId` cannot contain colons: keys would have to be mangled,
 *     whereas a probe UUID would fit as is.
 *   - A probe's interval is a number of seconds, not a cron. BullMQ could do it
 *     (`every`), but the slightest interval change would require rewriting the
 *     scheduler — two truths that drift apart.
 *   - Above all: fifty probes with a thirty-second timeout are twenty-five
 *     minutes of work if chained. Parallelism and the time budget must be
 *     decided **in a single place**, and a sweep is that place. Fifty repeatable
 *     jobs would fight for the queue's slots and starve the other reads.
 *
 * The probe's interval stays in the database: the sweep only claims the probes
 * whose `next_check_at` is due.
 *
 * On the `supervision` queue, with the rest of the reads: probing a site must
 * never delay a deployment, nor wait for it to finish.
 */
export const MONITOR_SWEEP_JOB = 'monitor:sweep' as const;

/**
 * "Probe now" reuses `MONITOR_SWEEP_JOB` with a `monitorId`: a second task name
 * for exactly the same work would be dead vocabulary, and a second path where
 * the SSRF policy could diverge.
 */

/**
 * Screenshot of a monitored page.
 *
 * ── Why a separate task, and not in the sweep ──────────────────────────────
 * Because **a screenshot must never delay an alert**. The sweep works under a
 * twenty-two-second budget for two hundred probes; a screenshot alone costs two
 * to ten seconds. Rendering fifty references in a sweep would exhaust the budget
 * and leave probes unqueried — that is, a convenience feature would degrade the
 * main feature.
 *
 * Separate, the screenshot leaves **after** the incident is written and the
 * alert is sent. It can fail, drag or never run: nothing that matters depends
 * on it.
 *
 * On the `supervision` queue, with the other reads: it is a page load to the
 * outside, it must neither delay a deployment nor wait for one. `attempts: 1` —
 * a failed screenshot is not replayed: the moment it was meant to show has
 * already passed, and an image taken three minutes after the incident would
 * tell something other than what it is asked.
 */
export const MONITOR_CAPTURE_JOB = 'monitor:capture' as const;

/**
 * Linked repositories: "what is new on the branch?".
 *
 * Scheduled every minute by the worker (a BullMQ scheduler, never a cron), and
 * enqueued on demand by "Check now" with a `sourceId`. On the monitoring queue:
 * they are short HTTP calls to the provider, which a deployment in progress must
 * not hold up.
 */
export const SOURCE_POLL_JOB = 'source:poll' as const;

/**
 * Deploying from a repository, on a human decision: the branch's head commit
 * ("Deploy this commit"), or a pending deployment being approved. Same queue as
 * the polling, and the same deployment function at the end: a single
 * implementation, whether the trigger is automatic or manual.
 */
export const SOURCE_DEPLOY_JOB = 'source:deploy' as const;

/**
 * Reading an uploaded code archive: judging it entry by entry, then making the
 * clean archive deployments will place. A few seconds of disk and CPU — nothing
 * that belongs in an HTTP route, nor that should wait behind a deployment: on
 * `supervision`, like the polling.
 */
export const SOURCE_ARCHIVE_INSPECT_JOB = 'source:archive-inspect' as const;

/**
 * Images of deployed applications: what runs, compared with what the registry
 * announces for the same tag. Every six hours (BullMQ scheduler), and on demand
 * by "Check now" with an `applicationId`. On `supervision`: reads — `HEAD` to
 * the registries, `docker inspect` on the targets —, which a deployment in
 * progress must not delay.
 */
export const IMAGE_CHECK_JOB = 'images:check' as const;
export const IMAGE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Image builder cleanup: every hour, each target where a runtime sets up a
 * builder (`DeploymentDriver.pruneIdleBuilder`) has it removed if it has not
 * been used for a long time — the driver says how long. On `ops`: it is a write
 * on the machine, which shares the deployments' concurrency discipline.
 */
export const BUILDER_PRUNE_JOB = 'builder:prune' as const;
export const BUILDER_PRUNE_EVERY_MS = 60 * 60 * 1000;

export const pingJobDataSchema = z.object({
  message: z.string().min(1).max(280).default('pong'),
  requestedAt: z.string().datetime(),
  /** Filled in as soon as an authentication exists. */
  actorId: z.string().min(1).nullable().default(null),
  ip: z.string().min(1).nullable().default(null),
});

export const pingJobResultSchema = z.object({
  ok: z.literal(true),
  message: z.string(),
  handledAt: z.string().datetime(),
  /** `null` if the audit write failed — that does not fail the task. */
  auditLogId: z.string().uuid().nullable(),
  workerId: z.string(),
});

export type PingJobData = z.infer<typeof pingJobDataSchema>;
export type PingJobResult = z.infer<typeof pingJobResultSchema>;

export const targetPreflightJobDataSchema = z.object({
  targetId: z.string().uuid(),
  /** User behind the request. `null` for a scheduled trigger. */
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
 * Cascading deletion.
 *
 * `force` does not mean "skip the destruction" but "delete anyway what could
 * not be destroyed". The attempt happens in both cases — a forcing that tries
 * nothing would be a bad tool —, only the conclusion differs.
 */
export const applicationDeleteJobDataSchema = z.object({
  applicationId: z.string().uuid(),
  force: z.boolean().default(false),
  actorId: z.string().min(1).nullable().default(null),
  ip: z.string().min(1).nullable().default(null),
});

/** A deployment actually torn down on its target. */
export const destroyedDeploymentSchema = z.object({
  deploymentId: z.string().uuid(),
  version: z.number().int().positive(),
  targetId: z.string().uuid(),
  targetName: z.string(),
});

/**
 * What a forcing abandons on a machine, **named**.
 *
 * It is the payload that goes into the activity log, and the only one that will
 * remain: once the record is deleted, nothing in the panel can find these three
 * pieces of information again. They are therefore chosen so that a human can
 * finish the cleanup by hand without the panel:
 *   — `targetHost` + `targetName`: which machine to connect to;
 *   — `workspace`: the Compose project (or namespace) to tear down, `app-{slug}`;
 *   — `publishedPort`: the port still promised, to check free before reuse.
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
  /** Why the clean destruction failed. */
  error: z.string(),
});

export const applicationDeleteJobResultSchema = z.object({
  applicationId: z.string().uuid(),
  applicationSlug: z.string(),
  forced: z.boolean(),
  /** Did the application really disappear from the database? */
  deleted: z.boolean(),
  destroyed: z.array(destroyedDeploymentSchema),
  /** Empty when everything was destroyed cleanly. */
  abandoned: z.array(abandonedWorkloadSchema),
  purgedCount: z.number().int().nonnegative(),
  releasedPorts: z.array(
    z.object({ targetId: z.string().uuid(), targetName: z.string(), port: z.number().int() }),
  ),
  /** A sentence that says exactly what was done and what was not. */
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
   * The workload's name as the caller saw it when deciding. It serves the audit
   * log and the messages: a deleted workload no longer has a name to look up
   * afterwards.
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
  exitCode: z.number().int().nullable().optional(),
});

export const workloadControlJobDataSchema = workloadActionJobDataSchema.extend({
  action: workloadControlActionSchema,
});

/**
 * A command in a workload. `run` designates this execution in the real-time
 * stream: the screen that started it only reads its own lines.
 */
export const workloadExecJobDataSchema = workloadActionJobDataSchema.extend({
  action: z.literal('exec'),
  command: z.string().trim().min(1).max(WORKLOAD_EXEC_MAX_COMMAND),
  run: z.string().uuid(),
});

export const workloadLogsJobDataSchema = workloadActionJobDataSchema.extend({
  action: z.literal('logs'),
  tail: z.number().int().min(10).max(WORKLOAD_LOGS_MAX_TAIL).default(300),
  run: z.string().uuid(),
});

export const targetMetricsJobDataSchema = z.object({
  targetId: z.string().uuid(),
  actorId: z.string().min(1).nullable().default(null),
  ip: z.string().min(1).nullable().default(null),
});

/**
 * The reading itself. An unreachable machine returns a `reachable:false` report
 * — not a failed task: the screen must be able to say *why* it knows nothing,
 * and keep showing what the database knows about the machine.
 */
export const targetMetricsJobResultSchema = hostMetricsSchema;

export type TargetMetricsJobData = z.infer<typeof targetMetricsJobDataSchema>;
export type TargetMetricsJobResult = z.infer<typeof targetMetricsJobResultSchema>;

export const sourcePollJobDataSchema = z.object({
  /** Restricts the check to one link. `null`: every active link. */
  sourceId: z.string().uuid().nullable().default(null),
  /** Ignores the ETag: asks again even if GitHub says "nothing new". */
  force: z.boolean().default(false),
  actorId: z.string().min(1).nullable().default(null),
  ip: z.string().min(1).nullable().default(null),
});
export type SourcePollJobData = z.infer<typeof sourcePollJobDataSchema>;

export const imageCheckJobDataSchema = z.object({
  /** Restricts the check to one application. `null`: everything deployed. */
  applicationId: z.string().uuid().nullable().default(null),
  actorId: z.string().min(1).nullable().default(null),
  ip: z.string().min(1).nullable().default(null),
});
export type ImageCheckJobData = z.infer<typeof imageCheckJobDataSchema>;

export const imageCheckJobResultSchema = z.object({
  /** (application, target) pairs examined. */
  checked: z.number().int().nonnegative(),
  /** Services whose tag moved. */
  outdated: z.number().int().nonnegative(),
  /** Announcements made — one per pair with something new. */
  announced: z.number().int().nonnegative(),
});
export type ImageCheckJobResult = z.infer<typeof imageCheckJobResultSchema>;

export const sourceDeployJobDataSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('head'),
    sourceId: z.string().uuid(),
    actorId: z.string().min(1).nullable().default(null),
    ip: z.string().min(1).nullable().default(null),
  }),
  z.object({
    kind: z.literal('proposal'),
    proposalId: z.string().uuid(),
    actorId: z.string().min(1).nullable().default(null),
    ip: z.string().min(1).nullable().default(null),
  }),
]);
export type SourceDeployJobData = z.infer<typeof sourceDeployJobDataSchema>;

export const sourceArchiveInspectJobDataSchema = z.object({
  archiveId: z.string().uuid(),
  actorId: z.string().min(1).nullable().default(null),
  ip: z.string().min(1).nullable().default(null),
});
export type SourceArchiveInspectJobData = z.infer<typeof sourceArchiveInspectJobDataSchema>;

export const monitorSweepJobDataSchema = z.object({
  /** Restricts the sweep to one probe. Used for the manual trigger. */
  monitorId: z.string().uuid().nullable().default(null),
  /** Overrides `next_check_at`: "probe now". */
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
  /** The sweep gave up on its time budget; the next one will pick up. */
  budgetExhausted: z.boolean(),
});

export type MonitorSweepJobData = z.infer<typeof monitorSweepJobDataSchema>;
export type MonitorSweepJobResult = z.infer<typeof monitorSweepJobResultSchema>;

/**
 * Two shapes, a discriminated union — because they are two requests with
 * neither the same trigger nor the same urgency, and a single object with
 * half-`null` fields would force the handler to guess which one it holds.
 *
 *   incident    "take a picture of this probe now, for this incident".
 *               Enqueued at the transition, one per transition.
 *   references  "refresh the references that have aged". Sweeps, capped at a
 *               few probes per pass. Nobody waits for it.
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
  /** Screenshots attempted. */
  attempted: z.number().int().nonnegative(),
  /** Screenshots saved. */
  stored: z.number().int().nonnegative(),
  /** Bytes written, all shots together. */
  bytes: z.number().int().nonnegative(),
  /**
   * Reasons of the screenshots that did not succeed. An empty list is not the
   * nominal case: a browser that is off fills this list, and that is **normal**.
   */
  skipped: z.array(z.string()),
});

export type MonitorCaptureJobData = z.infer<typeof monitorCaptureJobDataSchema>;
export type MonitorCaptureJobResult = z.infer<typeof monitorCaptureJobResultSchema>;

export type WorkloadListJobData = z.infer<typeof workloadListJobDataSchema>;
export type WorkloadListJobResult = z.infer<typeof workloadListJobResultSchema>;
export type WorkloadActionJobData = z.infer<typeof workloadActionJobDataSchema>;
export type WorkloadActionJobResult = z.infer<typeof workloadActionJobResultSchema>;
export type WorkloadControlJobData = z.infer<typeof workloadControlJobDataSchema>;
export type WorkloadExecJobData = z.infer<typeof workloadExecJobDataSchema>;
export type WorkloadLogsJobData = z.infer<typeof workloadLogsJobDataSchema>;

/** Every task the `ops` queue accepts. */
export type OpsJobMap = {
  [PING_JOB]: PingJobData;
  [TARGET_PREFLIGHT_JOB]: TargetPreflightJobData;
  [DEPLOYMENT_RUN_JOB]: DeploymentJobData;
  [DEPLOYMENT_ROLLBACK_JOB]: DeploymentJobData;
  [DEPLOYMENT_DESTROY_JOB]: DeploymentJobData;
  [APPLICATION_DELETE_JOB]: ApplicationDeleteJobData;
  [APP_LOGS_JOB]: DeploymentJobData;
  [APP_RESTART_JOB]: DeploymentJobData;
  [APP_STOP_JOB]: DeploymentJobData;
  [APP_START_JOB]: DeploymentJobData;
  [WORKLOAD_REMOVE_JOB]: WorkloadActionJobData;
  [WORKLOAD_UPDATE_JOB]: WorkloadActionJobData;
  [WORKLOAD_CONTROL_JOB]: WorkloadControlJobData;
  [WORKLOAD_EXEC_JOB]: WorkloadExecJobData;
};

export type OpsJobName = keyof OpsJobMap;

/* ---------------------------------------------------------------------------
   Notifications
   ------------------------------------------------------------------------- */

/**
 * Queue dedicated to notifications.
 *
 * Neither `ops` nor `supervision`, and it is not vanity:
 *
 *   — on `ops`, a "deployment failed" alert would wait behind the deployments in
 *     progress. Warning late amounts to not warning;
 *   — on `supervision`, it would wait behind log follows, which hold their slot
 *     for the whole viewing — up to thirty minutes. Eight open tabs would be
 *     enough to muzzle the alerts.
 *
 * The reasoning is exactly the one that justified `supervision` in its time: two
 * concurrency budgets, no possible starvation.
 */
export const NOTIFICATIONS_QUEUE = 'notifications' as const;

/**
 * Dispatching a notifiable event to the channels subscribed to it.
 *
 * One task **per event**, not per channel: the fan-out happens in the worker,
 * which reads the subscribed channels at once. Enqueuing per channel would force
 * the emitter — that is, the audit log observer, in the path of an HTTP request
 * — to query the database before returning.
 */
export const NOTIFICATION_DISPATCH_JOB = 'notification:dispatch' as const;

/** Manual test of a channel, triggered from the settings screen. */
export const NOTIFICATION_TEST_JOB = 'notification:test' as const;

/**
 * The audit entry behind the event, copied as is.
 *
 * The neutral message is **not** composed here but in the worker: composing it
 * requires the instance's name, the panel's URL and the actor's email, three
 * reads the emitter does not have to make in the path of a request.
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
  /** Channels subscribed and active at dispatch time. */
  targeted: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /**
   * What grouping decided (the volume guard's addition):
   *   immediate  the window was closed — the message goes right away
   *   held       a window is open — the event is held, named, in the database
   *   skipped    no subscribed channel: nothing to decide
   *   silenced   a maintenance window covers its subject — the alert is held, and
   *              will go out at the end if its problem is still there
   *
   * `delivered` and `failed` stay at zero since delivery became one task per
   * channel: it is `notification:deliver` that knows them, one channel at a time.
   * The fields are kept — old results in Redis carry them.
   */
  mode: z.enum(['immediate', 'held', 'skipped', 'silenced']).default('immediate'),
  /** Delivery tasks enqueued, one per subscribed channel. */
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
 * A test's verdict. `probe` is the result of `test()` — the check that delivers
 * nothing —, `delivered` that of the real send. Both are reported separately
 * because they fail for different reasons: a valid token whose chat ID is wrong
 * passes the first and misses the second.
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
 * Deduplication key of a dispatch.
 *
 * The real reason: a deployment task interrupted outside the pipeline is
 * replayed up to three times by BullMQ, and **each attempt writes its own
 * `deployment.failed` entry**. Without this key, one incident would produce three
 * identical emails a few seconds apart.
 *
 * The window is on the (event, resource) pair: two different deployments have
 * different identifiers and do not mask each other.
 *
 * **Except when the resource does not change from one occurrence to the next.**
 * That is the case of probes: the resource is the probe, the same yesterday and
 * today. Two distinct outages of the same site less than five minutes apart were
 * merged, and the second alert was swallowed without a trace — a deduplication
 * that loses an alert is worse than the duplicate it avoids. The catalog then
 * provides a discriminant (the incident identifier), which separates occurrences
 * without changing anything about absorbing replays: a replay copies the same
 * payload, hence the same discriminant.
 */
export function notificationDedupKey(
  event: string,
  resourceId: string | null,
  discriminator?: string | null,
): string {
  const base = `${event}|${resourceId ?? 'none'}`;
  return discriminator ? `${base}|${discriminator}` : base;
}

/** Five minutes: far beyond the few seconds replays last. */
export const NOTIFICATION_DEDUP_TTL_MS = 5 * 60_000;

/* ---------------------------------------------------------------------------
   Notifications — delivery per channel and grouping
   ------------------------------------------------------------------------- */

/**
 * Delivery to **one** channel.
 *
 * The second stage of the fan-out: `notification:dispatch` decides *what* to
 * send and *to whom*, `notification:deliver` sends, one channel at a time. The
 * split is not cosmetic — it is what makes replay correct. A single dispatch that
 * fails on the SMTP server and succeeds on Discord cannot be replayed without
 * sending the message to Discord again; that is why the layer delivered
 * yesterday held `attempts: 1`. One task per channel removes the dilemma: the
 * task that fails is that of a single recipient, and it replays alone.
 *
 * The emitter has not changed: it is still the worker that unfolds the fan-out,
 * never the audit log observer in the path of an HTTP request.
 */
export const NOTIFICATION_DELIVER_JOB = 'notification:deliver' as const;

/**
 * Sweep of the grouping windows that are due.
 *
 * A repeatable task, not a task delayed per window. A delayed task would be more
 * precise but would live in Redis, whereas the grouping state lives in the
 * database: the two could diverge, and the day Redis restarted empty, the open
 * windows would never close again. A sweep that reads the database again is
 * stateless — the same reasoning as the monitoring probes' sweep.
 */
export const NOTIFICATION_DIGEST_SWEEP_JOB = 'notification:digest_sweep' as const;

/**
 * What a delivery carries: the payload **already composed**.
 *
 * Composing the message again in the delivery task would force each attempt to
 * read the settings, the actor and the audit entry again — and a replay three
 * minutes later could produce a *different* message from the one the other
 * channels received. A message frozen at composition is the only one that
 * guarantees every recipient read the same thing.
 *
 * No secret travels in it: the neutral message contains none, and the channel's
 * configuration is read from the database again at send time.
 */
export const notificationDeliverJobDataSchema = z.object({
  channelId: z.string().uuid(),
  /** Copied for the logs: a channel deleted in the meantime no longer has a name. */
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
  /** Number of the attempt that succeeded (or of the last one). Starts at 1. */
  attempt: z.number().int().positive(),
  error: z.string().nullable(),
});

export type NotificationDeliverJobData = z.infer<typeof notificationDeliverJobDataSchema>;
export type NotificationDeliverJobResult = z.infer<typeof notificationDeliverJobResultSchema>;

export const notificationDigestSweepJobResultSchema = z.object({
  /** Groups whose window was due. */
  examined: z.number().int().nonnegative(),
  /** Digests actually composed — empty windows produce none. */
  digests: z.number().int().nonnegative(),
  /** Delivery tasks enqueued, all groups and all channels together. */
  queued: z.number().int().nonnegative(),
});

export type NotificationDigestSweepJobResult = z.infer<
  typeof notificationDigestSweepJobResultSchema
>;

/**
 * Replaying a delivery.
 *
 * Three attempts, spaced exponentially starting at five seconds. The case aimed
 * at is the hiccup: a 502 from Discord, SMTP greylisting, a network cut of a
 * handful of seconds. Beyond that, it is no longer a hiccup and insisting brings
 * nothing — the failure is then recorded on the channel, traced in the audit
 * log, and visible on screen.
 *
 * Delivery is *at least once*: a successful send whose acknowledgment gets lost
 * will go out twice. It is the accepted trade-off — a duplicate message is a
 * nuisance, an incident message that never left is an outage.
 */
export const NOTIFICATION_DELIVER_ATTEMPTS = 3;
export const NOTIFICATION_DELIVER_BACKOFF_MS = 5_000;

/* ---------------------------------------------------------------------------
   Account lifecycle — transactional e-mails
   ------------------------------------------------------------------------- */

/**
 * Invitation or password reset, by email.
 *
 * On the notifications queue, and not in the HTTP route that triggers it, for
 * the usual reason: the panel has **no SMTP transport**, `nodemailer` being
 * deliberately kept out of its graph like `ssh2`. It enqueues, the worker
 * delivers. A slow SMTP server takes some thirty seconds to time out, and nobody
 * should wait for that in a form.
 *
 * On the `notifications` queue rather than `ops`: it is an email send, it shares
 * the concurrency budget of email sends, and it must not wait behind a
 * deployment.
 */
export const ACCOUNT_MAIL_JOB = 'account:mail' as const;

/**
 * What an account email carries — and the only place where the question "where
 * does the token live?" comes up.
 *
 * The link carries a reset token: whoever opens it takes over the account. It
 * therefore goes through Redis **encrypted** (AES-256-GCM under `MASTER_KEY`, the
 * same cipher as the targets' SSH credentials), not in clear. Three reasons, in
 * order:
 *
 *   1. Redis is a cache, not a vault: it is not encrypted at rest, nor are its
 *      backups, and `MONITOR` shows the tasks' content there;
 *   2. a finished task stays in Redis for its retention time — much longer than
 *      the token's validity;
 *   3. `logAudit()` and Pino will only ever see ciphertext if either of them logs
 *      a task payload by mistake.
 *
 * Decryption is done by the worker, just before rendering. It is exactly the rule
 * applied to channel secrets: decrypted at the last moment, by whoever sends.
 */
export const accountMailJobDataSchema = z.object({
  kind: accountMailKindSchema,
  /** Account concerned — so that the delivery trace designates someone. */
  userId: z.string().min(1).max(200),
  to: z.string().min(3).max(200),
  recipientName: z.string().min(1).max(120),
  /** **Encrypted** action link. Never in clear in a task payload. */
  encryptedUrl: z.string().min(1).max(4000),
  expiresAt: z.string().datetime(),
  actor: z.string().min(1).max(200).nullable().default(null),
});

export const accountMailJobResultSchema = z.object({
  kind: accountMailKindSchema,
  delivered: z.boolean(),
  /** Name of the SMTP channel used. `null` if none was available. */
  channel: z.string().nullable(),
  /** Already redacted of any secret by `describeFailure()`. */
  error: z.string().nullable(),
});

export type AccountMailJobData = z.infer<typeof accountMailJobDataSchema>;
export type AccountMailJobResult = z.infer<typeof accountMailJobResultSchema>;

/**
 * A single attempt, and not three as for a notification delivery.
 *
 * Replay is worth it for an alert — an incident message that never left is an
 * outage, a duplicate is a nuisance. Here it is the reverse: the person is in
 * front of their screen, sees right away that nothing arrived, and asks again.
 * Three attempts five seconds apart would only keep a token alive longer in a
 * queue.
 */
export const ACCOUNT_MAIL_ATTEMPTS = 1;

/* ---------------------------------------------------------------------------
   Stuck deployments
   ------------------------------------------------------------------------- */

/**
 * ## How a ghost is told from a slow deployment
 *
 * A legitimate deployment can take several minutes: a `docker pull` of a big
 * image, a build, a healthcheck that gives an application time to start. No
 * delay honestly separates that case from a deployment nobody takes care of
 * anymore — a detector in too much of a hurry would declare a four-minute build
 * dead, and make the product less reliable than the failure it claims to fix.
 *
 * The chosen signal is therefore not a delay but a **proof of absence**: the
 * BullMQ task that carried this deployment no longer exists in any state where
 * it could still run. It is verifiable, not an assumption, and it is exactly
 * what BullMQ can tell.
 *
 * Those are the states below. They are listed **positively** — "what can still
 * run" — rather than negatively: one more state in a future version of BullMQ
 * would then be treated as "can still run", hence in favor of the deployment.
 * The possible error leans the right way.
 *
 * `completed` and `failed` are deliberately absent, and that is the heart of the
 * matter: a `failed` task **still exists** in the queue — seven days, by
 * retention — without any worker picking it up. It is precisely the state in
 * which BullMQ abandons a task whose worker died twice in a row ("job stalled
 * more than allowable limit"): it is marked failed without our handler ever
 * having run, hence without anybody writing the verdict in the database. The
 * deployment stays `running` forever.
 *
 * No "paused" state in this list: a paused queue keeps its tasks in `wait`, the
 * pause is a flag on the queue, not a task state.
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
 * Grace window before a deployment can be declared a ghost.
 *
 * It is **not** a death delay: death is proven by the absence of a task, never
 * by age. It only covers a single window, the enqueuing one:
 * `POST /api/deployments` writes the row in the database *then* enqueues the
 * task. In between, a perfectly healthy deployment indeed has no task. One
 * minute is three orders of magnitude above how long that interval lasts.
 */
export const STUCK_DEPLOYMENT_GRACE_MS = 60_000;

/**
 * What is read from a queue task to know whether it concerns a deployment.
 * Deliberately minimal: `@pupitre/core` does not depend on `bullmq` — this module
 * only describes the queues' contract, it opens none — and the caller, panel or
 * worker, passes what it read.
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
 * Can this task still move this deployment forward — or conclude it?
 *
 * The four names kept are those that write a deployment status:
 * `deployment:run` carries it end to end, `deployment:rollback` and
 * `deployment:destroy` conclude it, and `application:delete` destroys all of its
 * application's deployments in cascade — it does not cite a `deploymentId`, hence
 * the comparison on `applicationId`.
 *
 * The benefit of the doubt goes to the deployment: as long as a single one of
 * these tasks can still run, nothing is declared. Being wrong while waiting costs
 * a row blocked a few minutes longer; being wrong while concluding writes a false
 * verdict on a deployment that is still moving forward.
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

/* ---------------------------------------------------------------------------
   Sauvegardes
   ------------------------------------------------------------------------- */

/**
 * Queue dedicated to backups and restores.
 *
 * A nightly backup of ten applications is an hour of transfers: on `ops`, it
 * would make every morning deployment wait. Its own queue, its own concurrency
 * (one at a time by default — neither the target nor the destination likes being
 * solicited by ten archives at once).
 *
 * The **pre-deployment** backup does not go through it: it is a pipeline step,
 * run within the deployment task itself.
 */
export const BACKUPS_QUEUE = 'backups' as const;

export const BACKUP_APPLICATION_JOB = 'backup:application' as const;
export const BACKUP_PANEL_JOB = 'backup:panel' as const;
export const BACKUP_RESTORE_JOB = 'backup:restore' as const;
export const BACKUP_DELETE_JOB = 'backup:delete' as const;

/** Testing a destination: a few seconds of network, on `supervision`. */
export const BACKUP_DESTINATION_CHECK_JOB = 'backup:destination-check' as const;

const actorFields = {
  actorId: z.string().min(1).nullable().default(null),
  ip: z.string().min(1).nullable().default(null),
};

export const backupApplicationJobDataSchema = z.object({
  applicationId: z.string().uuid(),
  targetId: z.string().uuid(),
  trigger: backupTriggerSchema,
  /**
   * The `backups` row already created by the route, as `running`: the screen sees
   * it before the task even leaves. `null` for the scheduled task.
   */
  backupId: z.string().uuid().nullable().default(null),
  ...actorFields,
});
export type BackupApplicationJobData = z.infer<typeof backupApplicationJobDataSchema>;

export const backupPanelJobDataSchema = z.object({
  trigger: backupTriggerSchema,
  backupId: z.string().uuid().nullable().default(null),
  ...actorFields,
});
export type BackupPanelJobData = z.infer<typeof backupPanelJobDataSchema>;

export const backupRestoreJobDataSchema = z.object({
  backupId: z.string().uuid(),
  /** The target to restore to — the backup's by default. */
  targetId: z.string().uuid(),
  /** Back up the current state before overwriting it. */
  safetyBackup: z.boolean().default(true),
  ...actorFields,
});
export type BackupRestoreJobData = z.infer<typeof backupRestoreJobDataSchema>;

export const backupDeleteJobDataSchema = z.object({
  backupId: z.string().uuid(),
  ...actorFields,
});
export type BackupDeleteJobData = z.infer<typeof backupDeleteJobDataSchema>;

export const backupDestinationCheckJobDataSchema = z.object({
  destinationId: z.string().uuid(),
  ...actorFields,
});
export type BackupDestinationCheckJobData = z.infer<typeof backupDestinationCheckJobDataSchema>;

/** What a backup or a restore returns: enough to write it into the task's log. */
export const backupJobResultSchema = z.object({
  backupId: z.string().uuid().nullable(),
  status: z.enum(['success', 'failed', 'skipped']),
  bytes: z.number().int().nonnegative().default(0),
  detail: z.string().nullable().default(null),
});
export type BackupJobResult = z.infer<typeof backupJobResultSchema>;

// ─── reverse proxies ─────────────────────────────────────────────────────────
//
// On `ops`, like a deployment: each one opens an SSH session and can change the
// machine. The periodic route probe is a read: it goes through `supervision`.

export const PROXY_DETECT_JOB = 'proxy:detect' as const;
export const PROXY_INSTALL_JOB = 'proxy:install' as const;
export const PROXY_CHECK_JOB = 'proxy:check' as const;
export const PROXY_REMOVE_JOB = 'proxy:remove' as const;
/** Sets an application's domains on a target, without redeploying it. */
export const PROXY_APPLY_JOB = 'proxy:apply' as const;
/** Tests a machine's link to another one's proxy: addresses, reachability. */
export const PROXY_LINK_CHECK_JOB = 'proxy:link-check' as const;
export const ROUTES_CHECK_JOB = 'routes:check' as const;
/** Every ten minutes: a domain that goes down is seen quickly, without loading the machine. */
export const ROUTES_CHECK_EVERY_MS = 10 * 60_000;

/**
 * The domain probe: every route (the periodic round), or an application's routes
 * on a target — the close re-read that follows a certificate being issued.
 */
export const routesCheckJobDataSchema = z.object({
  applicationId: z.string().uuid().nullable().default(null),
  targetId: z.string().uuid().nullable().default(null),
});
export type RoutesCheckJobData = z.infer<typeof routesCheckJobDataSchema>;

/** Reading a certificate being issued again: 30 seconds, then 2 minutes. */
export const CERTIFICATE_RECHECK_DELAYS_MS = [30_000, 120_000] as const;

export const proxyDetectJobDataSchema = z.object({ targetId: z.string().uuid() });
export type ProxyDetectJobData = z.infer<typeof proxyDetectJobDataSchema>;

export const proxyInstallJobDataSchema = z.object({
  targetId: z.string().uuid(),
  proxyId: z.string().uuid(),
  option: z.string().min(1).max(32),
  acme: acmeSettingsSchema,
  ...actorFields,
});
export type ProxyInstallJobData = z.infer<typeof proxyInstallJobDataSchema>;

export const proxyCheckJobDataSchema = z.object({ proxyId: z.string().uuid() });
export type ProxyCheckJobData = z.infer<typeof proxyCheckJobDataSchema>;

export const proxyRemoveJobDataSchema = z.object({
  proxyId: z.string().uuid(),
  /** Also undo the installation, when Pupitre did it. */
  uninstall: z.boolean().default(false),
  ...actorFields,
});
export type ProxyRemoveJobData = z.infer<typeof proxyRemoveJobDataSchema>;

export const proxyLinkCheckJobDataSchema = z.object({ targetId: z.string().uuid() });
export type ProxyLinkCheckJobData = z.infer<typeof proxyLinkCheckJobDataSchema>;

export const proxyApplyJobDataSchema = z.object({
  applicationId: z.string().uuid(),
  targetId: z.string().uuid(),
  ...actorFields,
});
export type ProxyApplyJobData = z.infer<typeof proxyApplyJobDataSchema>;
