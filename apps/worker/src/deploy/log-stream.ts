import {
  deployChannel,
  stripAnsi,
  type DeployEvent,
  type DeployLogLine,
  type DeployMessage,
  type DeploymentStepKey,
} from '@pupitre/core';
import { appendStepLog } from '@pupitre/db';
import type { Redis } from 'ioredis';
import { logger } from '../logger.js';

/**
 * Streaming deployment logs.
 *
 * Two destinations, a single source:
 *   - Redis pub/sub, for the live feed over SSE;
 *   - `deployment_steps.log`, for replay afterwards.
 *
 * Database writes are grouped: a `docker compose pull` line every 30 ms would
 * make as many UPDATEs, which would drown the database for nothing.
 *
 * **We publish after persisting, never the reverse.** The order matters: Redis
 * pub/sub has no history, and a client that connects can only catch up on the
 * past through the database. Publishing first would open a window — as wide as
 * the whole grouping interval — where a line has already gone out on the
 * channel but is not written yet: the newcomer misses it on both sides and loses
 * it for good. Publishing after the write guarantees "broadcast ⇒ durable", and
 * the history/live seam becomes safe by construction rather than by luck.
 *
 * The price is a delay of at most `FLUSH_INTERVAL_MS` on the live feed. For a
 * deployment log, it is imperceptible.
 */

const FLUSH_INTERVAL_MS = 400;
const FLUSH_THRESHOLD = 40;

export class DeployLogStream {
  private buffers = new Map<DeploymentStepKey, string[]>();
  /**
   * The same lines, flat and in emission order — the per-step buffers serve the
   * grouped write, this one serves the broadcast, which must stay globally ordered
   * even when two steps speak in the same batch.
   */
  private pendingPublish: DeployMessage[] = [];
  /**
   * Every publication goes through this chain. Without it, an end event published
   * while a batch of lines is still being written would overtake those lines and
   * close the stream before they arrive.
   */
  private publishQueue: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private readonly channel: string;
  /**
   * Last line emitted per step.
   *
   * `docker compose` redraws its progress lines: deprived of a TTY, it emits the
   * same text several times in a row ("Network … Creating" appears twice). Once
   * the ANSI sequences are removed, these redraws become strict consecutive
   * duplicates — we discard them here, at the source, rather than persist then
   * replay them.
   */
  private lastLine = new Map<DeploymentStepKey, string>();

  constructor(
    private readonly deploymentId: string,
    private readonly publisher: Redis,
  ) {
    this.channel = deployChannel(deploymentId);
  }

  /** Emits a line: buffered, then database and Redis at the next batch. */
  line(step: DeploymentStepKey, text: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    const cleaned = stripAnsi(text).replace(/\r$/, '');
    if (cleaned.trim().length === 0) return;
    if (this.lastLine.get(step) === cleaned) return;
    this.lastLine.set(step, cleaned);

    const payload: DeployLogLine = {
      ts: new Date().toISOString(),
      step,
      stream,
      line: cleaned,
    };

    this.pendingPublish.push({ kind: 'log', payload });

    const buffer = this.buffers.get(step) ?? [];
    buffer.push(JSON.stringify(payload));
    this.buffers.set(step, buffer);

    if (buffer.length >= FLUSH_THRESHOLD) {
      void this.flush();
    } else {
      this.schedule();
    }
  }

  /**
   * Emits a state change. Not persisted: the database already carries the state.
   *
   * Flushes what is waiting first, so that an event never arrives before the
   * lines preceding it — the terminal event closes the stream on the client side.
   */
  event(event: Omit<DeployEvent, 'ts'>): void {
    const message: DeployMessage = {
      kind: 'event',
      payload: { ts: new Date().toISOString(), ...event },
    };
    void this.flush().then(() => {
      this.enqueuePublish([message]);
    });
  }

  /** Serializes the publications so that emission order is preserved. */
  private enqueuePublish(messages: readonly DeployMessage[]): void {
    if (messages.length === 0) return;
    const batch = [...messages];
    this.publishQueue = this.publishQueue.then(async () => {
      for (const message of batch) {
        try {
          await this.publisher.publish(this.channel, JSON.stringify(message));
        } catch (error) {
          logger.warn({ err: error, channel: this.channel }, 'Redis publication failed');
        }
      }
    });
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  /** Writes to the database everything that is pending. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const pending = [...this.buffers.entries()].filter(([, lines]) => lines.length > 0);
    this.buffers.clear();
    const toPublish = this.pendingPublish;
    this.pendingPublish = [];

    for (const [step, lines] of pending) {
      try {
        await appendStepLog(this.deploymentId, step, `${lines.join('\n')}\n`);
      } catch (error) {
        // The line will not be readable afterwards, but silencing it would also deprive
        // the current viewer. We broadcast anyway, and the warning keeps a trace of the
        // lost durability.
        logger.warn(
          { err: error, deploymentId: this.deploymentId, step },
          'step log not persisted',
        );
      }
    }

    this.enqueuePublish(toPublish);
  }

  async close(): Promise<void> {
    await this.flush();
    // The publication chain carries the last batch: waiting for it avoids cutting
    // the Redis connection before it has gone out.
    await this.publishQueue;
  }
}
