import { createCaptureEgress, type CaptureEgress } from '@pupitre/core/capture';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { captureEnabled } from './capture.js';
import { allowedCidrs } from './policy.js';

/**
 * Le mandataire par lequel le navigateur de capture sort — cycle de vie.
 *
 * Ouvert **seulement** quand la capture est configurée : une instance qui n'en
 * veut pas n'ouvre aucun port supplémentaire. Sa raison d'être et la mesure qui
 * l'a rendu nécessaire sont dans `packages/core/src/capture/egress.ts` — en
 * deux lignes : deux réseaux Docker distincts ne sont **pas** isolés l'un de
 * l'autre, seul `internal: true` l'est, et un réseau interne coupe aussi
 * l'Internet. Le mandataire est la porte, et la garde SSRF en est le portier.
 */

let egress: CaptureEgress | null = null;

export async function startCaptureEgress(): Promise<void> {
  if (!captureEnabled()) {
    logger.debug('capture désactivée — aucun mandataire de sortie ouvert');
    return;
  }
  egress = await createCaptureEgress({
    allowlist: allowedCidrs(),
    port: env.MONITOR_CAPTURE_EGRESS_PORT,
    onBlocked: (target, reason) => {
      // Le refus est **la** trace qui compte : c'est une page supervisée qui a
      // tenté d'atteindre autre chose que sa propre origine publique. Jamais en
      // silence.
      logger.warn({ target, reason }, 'sortie du navigateur de capture refusée');
    },
  });
  logger.info(
    { port: egress.port, cdp: env.MONITOR_CAPTURE_CDP_URL },
    'mandataire de sortie du navigateur de capture ouvert',
  );
}

export async function stopCaptureEgress(): Promise<void> {
  if (!egress) return;
  await egress.close();
  egress = null;
}
