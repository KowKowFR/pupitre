import { z } from 'zod';
import { translator, type Translated, type UiLanguage } from './i18n.js';
import { serviceStateSchema } from './supervision.js';

/**
 * Workloads running on a target machine.
 *
 * "Workload" and not "container": a target can run K3s, where what runs is a
 * pod driven by a Deployment. The panel can write "container" in its interface
 * when the target runs Docker — but it is the screen that chooses that word,
 * from the `kind` key the driver set. The code stays neutral, and no caller ever
 * tests the runtime to know what to do.
 *
 * Distinct from `supervision.ts`: that one tells about the services **of a
 * panel deployment**, this one tells about **everything running on the
 * machine**, whether the panel's or not. The `managed` field is exactly the
 * boundary between the two.
 */

/**
 * Structurally identical to `RuntimeKind` (`drivers/types.ts`), and
 * deliberately declared again: this module is re-exported by `index.ts`, which
 * the Next panel imports. Importing the drivers from here would pull `ssh2` into
 * its dependency graph, which the architecture forbids.
 */
export const workloadRuntimeSchema = z.enum(['docker', 'k3s']);
export type WorkloadRuntime = z.infer<typeof workloadRuntimeSchema>;

/**
 * A workload's designation, as passed from a screen to a job then to a driver.
 *
 * `id` is an **opaque handle**: only the named runtime's driver can produce and
 * read it back. The panel never interprets it — that is what allows adding a
 * third runtime without touching a line of API.
 */
export const workloadRefSchema = z.object({
  runtime: workloadRuntimeSchema,
  id: z.string().min(1).max(300),
});
export type WorkloadRef = z.infer<typeof workloadRefSchema>;

/**
 * Transportable form of a reference, for a URL segment.
 *
 * `:` is legal in a path segment, absent from a Docker identifier (hexadecimal)
 * as from a Kubernetes name (DNS-1123). Be careful, however, never to reuse this
 * string as a BullMQ job identifier: `Queue.add()` refuses a "Custom Id"
 * containing a `:`.
 */
export function encodeWorkloadRef(ref: WorkloadRef): string {
  return `${ref.runtime}:${ref.id}`;
}

export function decodeWorkloadRef(raw: string): WorkloadRef | null {
  const separator = raw.indexOf(':');
  if (separator <= 0) return null;

  const parsed = workloadRefSchema.safeParse({
    runtime: raw.slice(0, separator),
    id: raw.slice(separator + 1),
  });
  return parsed.success ? parsed.data : null;
}

/** The life-cycle gestures: a process that starts, stops, restarts. */
export const WORKLOAD_CONTROL_ACTIONS = ['start', 'stop', 'restart'] as const;
export const workloadControlActionSchema = z.enum(WORKLOAD_CONTROL_ACTIONS);
export type WorkloadControlAction = z.infer<typeof workloadControlActionSchema>;

export const workloadSchema = z.object({
  runtime: workloadRuntimeSchema,
  /** Opaque handle, produced and read back by this runtime's driver alone. */
  id: z.string().min(1),
  name: z.string().min(1),
  /**
   * Kind of workload, in **this runtime**'s vocabulary: `container`,
   * `deployment`, `statefulset`, `daemonset`, `pod`.
   *
   * It is a **key**, not a sentence — just like a `runtime` or a `state`. The
   * driver produces stable data; the screen that shows it gives it its word
   * (`workload.kind.*` in `messages/targets.ts`) and falls back on the bare key if
   * a future runtime names one it does not know. Nothing in between uses it to
   * decide anything.
   *
   * The field is deliberately not an enumeration: adding a runtime must stay a
   * matter of a class, and an unknown kind must show as is rather than fail the
   * reading of the whole inventory.
   */
  kind: z.string().min(1),
  /** Runtime-specific grouping: Compose project, Kubernetes namespace. */
  scope: z.string().nullable().default(null),
  image: z.string().nullable().default(null),
  /** The same vocabulary as monitoring: no second set of states. */
  state: serviceStateSchema,
  health: z.enum(['healthy', 'unhealthy', 'starting', 'none']).default('none'),
  createdAt: z.string().nullable().default(null),
  /** The runtime's wording: "Up 2 hours", "2/2 ready". */
  since: z.string().nullable().default(null),
  /** Published ports, as the runtime words them. */
  ports: z.array(z.string()).default([]),
  /**
   * Is the panel responsible for this workload's life cycle?
   *
   * A panel workload already has its gestures — redeploy, restart, destroy,
   * rollback — and a database row that records them. Deleting it through this
   * screen would leave the database convinced that the application still runs,
   * its port reserved for nothing.
   */
  managed: z.boolean(),
  /** The panel application's slug, when `managed` is true. */
  managedApp: z.string().nullable().default(null),
  /**
   * The life-cycle gestures **this runtime** accepts for this workload, in its
   * present state — it is the driver that knows: a DaemonSet does not stop, a bare
   * pod does not restart, a stopped container does not stop twice, a panel
   * workload only restarts. The screen only offers those; the route and the
   * driver check again.
   */
  controls: z.array(workloadControlActionSchema).default([]),
  /** Can a command be run in it now? */
  exec: z.boolean().default(false),
});
export type Workload = z.infer<typeof workloadSchema>;

export const workloadListSchema = z.object({
  targetId: z.string().uuid(),
  checkedAt: z.string(),
  items: z.array(workloadSchema),
  /**
   * Runtimes queried and, if need be, why one of them could not say anything. An
   * empty list is ambiguous: "nothing runs" and "kubectl is unreachable" do not
   * look alike.
   */
  runtimes: z.array(
    z.object({
      runtime: workloadRuntimeSchema,
      ok: z.boolean(),
      error: z.string().nullable().default(null),
      count: z.number().int().nonnegative(),
    }),
  ),
});
export type WorkloadList = z.infer<typeof workloadListSchema>;

export const workloadActionSchema = z.enum([
  'remove',
  'update',
  'start',
  'stop',
  'restart',
  'logs',
  'exec',
]);
export type WorkloadAction = z.infer<typeof workloadActionSchema>;

/** A command sent into a workload: bounded in size, duration and output. */
export const WORKLOAD_EXEC_MAX_COMMAND = 2000;
export const WORKLOAD_EXEC_TIMEOUT_SEC = 120;
export const WORKLOAD_EXEC_MAX_LINES = 2000;
export const WORKLOAD_LOGS_MAX_TAIL = 2000;

/**
 * Progress of an action on a workload, published on Redis and relayed over SSE.
 * The same principle as deployment logs: the driver emits lines, the worker
 * publishes them, the route relays them. No `tail` on a file.
 */
export const workloadMessageSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('log'),
    payload: z.object({
      ts: z.string(),
      ref: z.string(),
      line: z.string(),
      /**
       * The run the line belongs to — a command, a log read. Two screens open on the
       * same workload do not mix their outputs. Absent on the older actions (delete,
       * update), which only have one at a time.
       */
      run: z.string().optional(),
    }),
  }),
  z.object({
    kind: z.literal('lifecycle'),
    payload: z.object({
      ts: z.string(),
      ref: z.string(),
      name: z.string(),
      action: workloadActionSchema,
      status: z.enum(['started', 'succeeded', 'failed']),
      detail: z.string().nullable().default(null),
      run: z.string().optional(),
      /** A command's exit code, once finished. */
      exitCode: z.number().int().nullable().optional(),
      /** The command exceeded its timeout and was interrupted. */
      timedOut: z.boolean().optional(),
      /** The output exceeded its cap: the following lines were not sent. */
      truncated: z.boolean().optional(),
    }),
  }),
]);
export type WorkloadMessage = z.infer<typeof workloadMessageSchema>;

/** Redis channel of the actions on a target's workloads. */
export function workloadChannel(targetId: string): string {
  return `workload:${targetId}`;
}

/**
 * The refusal's words, in one place.
 *
 * The sentence exists in two versions rather than one with an optional piece: a
 * panel workload attached to an application is named by that application, and
 * sewing "(application "…")" into the middle of a template forces both
 * languages to put the parenthesis at the same place. Two keys cost one line and
 * let English turn its sentence as it likes.
 */
const fr = {
  'managed.refusal':
    '« {name} » est déployée par le panel : ' +
    'cet écran ne la supprime pas. Passez par la destruction du déploiement ' +
    "(permission « deployment:destroy »), qui libère aussi son port et met la base à jour.",
  'managed.refusal.app':
    '« {name} » est déployée par le panel (application « {app} ») : ' +
    'cet écran ne la supprime pas. Passez par la destruction du déploiement ' +
    "(permission « deployment:destroy »), qui libère aussi son port et met la base à jour.",
  'managed.control':
    '« {name} » est déployée par le panel : on ne l’arrête ni ne la démarre d’ici, ' +
    'sinon le panel la croirait toujours en marche. Passez par « Arrêter » ou « Démarrer » ' +
    "sur la page Supervision de l'application — le redémarrage, lui, reste possible ici.",
} as const;

const en: Translated<typeof fr> = {
  'managed.refusal':
    '“{name}” is deployed by the panel: this screen will not remove it. Destroy the ' +
    'deployment instead (permission “deployment:destroy”) — that also frees its port and ' +
    'updates the database.',
  'managed.refusal.app':
    '“{name}” is deployed by the panel (application “{app}”): this screen will not remove ' +
    'it. Destroy the deployment instead (permission “deployment:destroy”) — that also frees ' +
    'its port and updates the database.',
  'managed.control':
    '“{name}” is deployed by the panel: it is neither stopped nor started from here, or the ' +
    'panel would still believe it runs. Use “Stop” or “Start” on the application’s ' +
    'Supervision page — restarting it stays possible here.',
};

export const workloadCopy = { fr, en };

/**
 * A refusal's message, in one place: the HTTP route returns it as a 409, the
 * driver raises it as a `DriverError`, and both therefore say the same thing.
 *
 * French by default: a driver raises this error deep in a job, without an
 * instance language at hand, and its trace is read in the logs. The panel
 * passes its own.
 */
export function managedWorkloadRefusal(
  workload: Pick<Workload, 'name' | 'managedApp'>,
  language: UiLanguage = 'fr',
): string {
  const t = translator(workloadCopy, language);
  const app = workload.managedApp;
  return app
    ? t('managed.refusal.app', { name: workload.name, app })
    : t('managed.refusal', { name: workload.name });
}

/** The refusal to stop or start a panel workload outside its Monitoring page. */
export function managedWorkloadControlRefusal(
  workload: Pick<Workload, 'name'>,
  language: UiLanguage = 'fr',
): string {
  return translator(workloadCopy, language)('managed.control', { name: workload.name });
}
