import { evaluateThresholds, listTargetSamples } from '@pupitre/db';
import { logger } from '../logger.js';
import { notifyBreachTransition } from './notify.js';

/**
 * Judge a machine's last reading, and only announce the flips.
 *
 * A single place, called by **both** triggers: the periodic sweep and the
 * reading asked from the screen. Duplicating these ten lines in both paths would
 * have been enough for them to diverge — one announcing recoveries, the other
 * not, six months later.
 */
export async function judgeAndAnnounce(target: {
  id: string;
  name: string;
}): Promise<{ breached: number; cleared: number }> {
  const transitions = await evaluateThresholds(target.id);
  if (transitions.length === 0) return { breached: 0, cleared: 0 };

  // The reading just written: the catalog needs it to compose its sentence — the
  // disk's path, the number of cores.
  const [latest] = await listTargetSamples(target.id, 1);
  if (!latest) return { breached: 0, cleared: 0 };

  let breached = 0;
  let cleared = 0;

  for (const transition of transitions) {
    if (transition.kind === 'opened') breached += 1;
    else cleared += 1;
    try {
      await notifyBreachTransition(target, transition, latest);
    } catch (error) {
      // A message that does not go out must not take the reading with it, which is
      // already in the database. The reverse would be serious.
      logger.error({ err: error, targetId: target.id }, 'crossing announcement failed');
    }
  }

  return { breached, cleared };
}
