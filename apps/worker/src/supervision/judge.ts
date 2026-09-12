import { evaluateThresholds, listTargetSamples } from '@pupitre/db';
import { logger } from '../logger.js';
import { notifyBreachTransition } from './notify.js';

/**
 * Juger le dernier relevé d'une machine, et n'annoncer que les bascules.
 *
 * Un seul endroit, appelé par les **deux** déclencheurs : le balayage
 * périodique et le relevé demandé depuis l'écran. Dupliquer cette dizaine de
 * lignes dans les deux chemins aurait suffi à ce qu'ils divergent — l'un
 * annonçant les rétablissements, l'autre non, six mois plus tard.
 */
export async function judgeAndAnnounce(target: {
  id: string;
  name: string;
}): Promise<{ breached: number; cleared: number }> {
  const transitions = await evaluateThresholds(target.id);
  if (transitions.length === 0) return { breached: 0, cleared: 0 };

  // Le relevé qui vient d'être écrit : le catalogue en a besoin pour composer
  // sa phrase — le chemin du disque, le nombre de cœurs.
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
      // Un message qui ne part pas ne doit pas emporter le relevé, qui, lui,
      // est déjà en base. C'est l'inverse qui serait grave.
      logger.error({ err: error, targetId: target.id }, 'annonce de franchissement impossible');
    }
  }

  return { breached, cleared };
}
