import type { HostMetrics } from '@pupitre/core';
import { collectHostMetrics } from '@pupitre/core/ssh';
import { getTargetSecret, recordTargetSample, type SampleSource } from '@pupitre/db';
import { sshTargetOf } from '../deploy/ssh-target.js';
import { env } from '../env.js';
import { instanceLanguage } from '../language.js';
import { logger } from '../logger.js';

/**
 * Read a machine, and **keep** the reading.
 *
 * A single write path, two triggers: the periodic sweep and the screen's "Read
 * now" button. It is the point of this work: until now the reading travelled
 * through the job's return value and died with the HTTP response. An SSH session
 * was opened on a real machine, then thrown away.
 *
 * The reading is still returned to the caller — the screen still shows it to the
 * second, and the route waiting for it did not change. It is simply written in
 * passing.
 */
export async function collectAndRecord(
  targetId: string,
  source: SampleSource,
): Promise<{ metrics: HostMetrics; recorded: boolean }> {
  const record = await getTargetSecret(targetId);
  if (!record) throw new Error(`Target "${targetId}" not found`);

  const metrics = await collectHostMetrics(targetId, sshTargetOf(record), {
    rootPath: env.DRIVER_ROOT_PATH,
    language: await instanceLanguage(),
    logger,
  });

  // The write must never make whoever waits for the reading lose it: a database
  // momentarily unavailable degrades the history, it does not break the screen.
  // The same trade-off as `logAudit()`, which never throws either.
  try {
    await recordTargetSample(metrics, source);
  } catch (error) {
    logger.error({ err: error, targetId }, 'reading could not be recorded — incomplete history');
    // `recorded: false`: the caller will not evaluate thresholds. Judging without
    // the day's measurement is judging the previous one again and inflating its
    // episode with a reading that was never written.
    return { metrics, recorded: false };
  }

  return { metrics, recorded: true };
}
