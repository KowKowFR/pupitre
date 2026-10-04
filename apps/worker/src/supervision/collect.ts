import type { HostMetrics } from '@pupitre/core';
import { collectHostMetrics } from '@pupitre/core/ssh';
import { getTargetSecret, recordTargetSample, type SampleSource } from '@pupitre/db';
import { sshTargetOf } from '../deploy/ssh-target.js';
import { env } from '../env.js';
import { instanceLanguage } from '../language.js';
import { logger } from '../logger.js';

/**
 * Relever une machine, et **garder** le relevé.
 *
 * Un seul chemin d'écriture, deux déclencheurs : le balayage périodique et le
 * bouton « Relever » de l'écran. C'est le point du chantier : jusqu'ici le
 * relevé voyageait par la valeur de retour du job et mourait avec la réponse
 * HTTP. Une session SSH était ouverte sur une vraie machine, puis jetée.
 *
 * Le relevé continue d'être rendu à l'appelant — l'écran l'affiche toujours à
 * la seconde près, et la route qui l'attend n'a pas changé. Il est simplement
 * écrit au passage.
 */
export async function collectAndRecord(
  targetId: string,
  source: SampleSource,
): Promise<{ metrics: HostMetrics; recorded: boolean }> {
  const record = await getTargetSecret(targetId);
  if (!record) throw new Error(`Cible « ${targetId} » introuvable`);

  const metrics = await collectHostMetrics(targetId, sshTargetOf(record), {
    rootPath: env.DRIVER_ROOT_PATH,
    language: await instanceLanguage(),
    logger,
  });

  // L'écriture ne doit jamais faire perdre le relevé à celui qui l'attend :
  // une base momentanément indisponible dégrade l'historique, elle ne casse pas
  // l'écran. Même arbitrage que `logAudit()`, qui ne throw jamais non plus.
  try {
    await recordTargetSample(metrics, source);
  } catch (error) {
    logger.error({ err: error, targetId }, "relevé impossible à enregistrer — historique incomplet");
    // `recorded: false` : l'appelant n'évaluera pas les seuils. Juger sans la
    // mesure du jour, c'est rejuger celle d'avant et gonfler son épisode d'un
    // relevé qui n'a jamais été écrit.
    return { metrics, recorded: false };
  }

  return { metrics, recorded: true };
}
