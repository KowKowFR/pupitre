import { evaluateReachability, getTarget, logAudit } from '@pupitre/db';
import { logger } from '../logger.js';

/**
 * Turns a reachability flip into a message — through `logAudit()`, like
 * threshold crossings (`notify.ts`): writing the audit **is** the emission, the
 * observer recognizes it in the catalog (`target.unreachable`,
 * `target.reachable`) and delivers it to the subscribed channels.
 *
 * A machine turned off crosses no threshold: its readings fail, and that is
 * precisely what thresholds cannot say. Without this announcement, it goes down
 * silently.
 */
export async function judgeReachability(target: {
  id: string;
  name: string;
}): Promise<'unreachable' | 'reachable' | null> {
  try {
    const transition = await evaluateReachability(target.id);
    if (!transition) return null;
    const record = await getTarget(target.id);
    const downSeconds = Math.max(
      0,
      Math.round((transition.at.getTime() - transition.since.getTime()) / 1000),
    );
    await logAudit({
      action: transition.kind === 'unreachable' ? 'target.unreachable' : 'target.reachable',
      resourceType: 'target',
      resourceId: target.id,
      after: {
        targetName: target.name,
        host: record?.host ?? null,
        since: transition.since.toISOString(),
        downSeconds,
        ...(transition.kind === 'unreachable'
          ? { failures: transition.failures, error: transition.error }
          : {}),
      },
    });
    return transition.kind;
  } catch (error) {
    // As for thresholds: a message that does not go out must not take the reading
    // with it, which is already in the database.
    logger.error({ err: error, targetId: target.id }, 'reachability flip not announced');
    return null;
  }
}
