import { z } from 'zod';

/**
 * Monitoring of running applications.
 *
 * Distinct from the pipeline: that one tells about a deployment, this one tells
 * about what runs *now*. Both have their own Redis channels and their own SSE
 * streams — mixing the two would make each as unreadable as the other.
 */

export const serviceStateSchema = z.enum([
  'running',
  'restarting',
  'exited',
  'paused',
  'created',
  'unknown',
]);
export type ServiceState = z.infer<typeof serviceStateSchema>;

/** A service's state as the runtime reports it. */
export const serviceStatusSchema = z.object({
  name: z.string().min(1),
  state: serviceStateSchema,
  /** Health reported by the container's probe, when it declares one. */
  health: z.enum(['healthy', 'unhealthy', 'starting', 'none']).default('none'),
  /** Since when, as the runtime shows it — "Up 2 hours". */
  since: z.string().nullable().default(null),
  image: z.string().nullable().default(null),
  ports: z.array(z.string()).default([]),
});
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;

export const appStatusSchema = z.object({
  services: z.array(serviceStatusSchema),
  checkedAt: z.string(),
});
export type AppStatus = z.infer<typeof appStatusSchema>;

/** An application log line, as the runtime produces it. */
export const appLogLineSchema = z.object({
  ts: z.string(),
  /** Emitting service, when the runtime prefixes it. */
  service: z.string().nullable().default(null),
  line: z.string(),
});
export type AppLogLine = z.infer<typeof appLogLineSchema>;

export const appLogMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('log'), payload: appLogLineSchema }),
  z.object({ kind: z.literal('status'), payload: appStatusSchema }),
  z.object({
    kind: z.literal('lifecycle'),
    payload: z.object({
      ts: z.string(),
      // `stop` and `start` come in addition to `restart`: they are the same
      // operations gestures, they are told in the same stream and in front of the same
      // viewer. A consumer that does not know them ignores them — the console already
      // filters on the action it can show.
      action: z.enum([
        'restart',
        'stop',
        'start',
        'stream.started',
        'stream.stopped',
        'stream.error',
      ]),
      detail: z.string().nullable().default(null),
      /**
       * The last event of a gesture (`restart`, `stop`, `start`). Screens rely
       * on it, never on `detail`: the detail is written in the instance's
       * language, and a word compared in one language misses the other.
       */
      done: z.boolean().optional(),
    }),
  }),
]);
export type AppLogMessage = z.infer<typeof appLogMessageSchema>;

/** Redis channel of a deployment's application logs. */
export function appLogChannel(deploymentId: string): string {
  return `app-logs:${deploymentId}`;
}

/**
 * A viewer's presence key, with a short lifetime.
 *
 * It is what drives stopping the stream: the SSE route refreshes it as long as a
 * client listens, the worker reads it regularly and cuts the SSH session as soon
 * as it has disappeared. A tab closed abruptly emits nothing — but the key
 * expires, and the stream stops by itself. Several viewers refresh the same key:
 * the last one out turns off the light.
 */
export function appLogWatchKey(deploymentId: string): string {
  return `app-logs:watch:${deploymentId}`;
}

/** Lifetime of the presence key. */
export const WATCH_TTL_SECONDS = 25;

/** Refresh rate on the panel side. Must stay well under the TTL. */
export const WATCH_REFRESH_MS = 8_000;

/** Re-read rate on the worker side. */
export const WATCH_POLL_MS = 5_000;

/**
 * The application's last known state, kept **outside the stream**.
 *
 * A Redis `publish` is not replayed: whoever subscribes afterwards gets
 * nothing. But the stream is shared — a single job for all the viewers of a
 * deployment — so the second tab, the page reload and the reconnection after a
 * cut all join a stream **already open**, whose state snapshot went by long
 * ago. That is exactly what made the screen say "no container reported by the
 * target" while a container's logs were scrolling: the state had never been
 * received, not read as empty.
 *
 * Hence this key: the worker places each reading in it, the SSE route reads it
 * at connection and serves it to the newcomer even before the first log line.
 * The reading carries its `checkedAt` — the screen therefore says its age, it
 * does not pass it off as fresh.
 */
export function appStatusKey(deploymentId: string): string {
  return `app-logs:status:${deploymentId}`;
}

/**
 * Lifetime of the last known state. Large compared with the reading rate: the
 * key must survive a stream that reopens (the time for a tab to reconnect), not
 * a whole night. Beyond that, better show nothing than yesterday's inventory.
 */
export const STATUS_TTL_SECONDS = 300;

/**
 * Rate of re-reading the state while a stream is open.
 *
 * The opening snapshot is not enough: a stream lives up to thirty minutes,
 * during which a container can exit, restart in a loop or become unhealthy
 * without the state card moving by a pixel. Twenty seconds, because the reading
 * borrows the SSH session **already open** for the logs — no connection to
 * establish, a `compose ps` of a few hundred milliseconds. It is the only
 * recurring cost imposed on the target machine, and it only exists while
 * someone is looking at the screen.
 */
export const STATUS_REFRESH_MS = 20_000;

/**
 * Maximum duration of a stream, whatever happens. A worker slot must not stay
 * taken indefinitely because a tab stayed open a whole weekend. The panel asks
 * for a stream again at reconnection: the cut is invisible.
 */
export const STREAM_MAX_MS = 30 * 60_000;

/** A deployment whose application can be followed and restarted. */
export function isSupervisable(status: string): boolean {
  return status === 'success' || status === 'rolled_back';
}
