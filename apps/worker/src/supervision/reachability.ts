import { evaluateReachability, getTarget, logAudit } from '@pupitre/db';
import { logger } from '../logger.js';

/**
 * Fait d'une bascule de joignabilité un message — par `logAudit()`, comme les
 * franchissements de seuil (`notify.ts`) : écrire l'audit **est** l'émission,
 * l'observateur la reconnaît au catalogue (`target.unreachable`,
 * `target.reachable`) et la distribue aux canaux abonnés.
 *
 * Une machine éteinte ne franchit aucun seuil : ses relevés échouent, et c'est
 * précisément ce que les seuils ne savent pas dire. Sans cette annonce, elle
 * tombe en silence.
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
    // Comme pour les seuils : un message qui ne part pas ne doit pas emporter
    // le relevé, qui, lui, est déjà en base.
    logger.error({ err: error, targetId: target.id }, 'bascule de joignabilité non annoncée');
    return null;
  }
}
