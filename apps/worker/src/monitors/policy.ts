import { parseCidrList, type Cidr } from '@pupitre/core';
import { env } from '../env.js';
import { logger } from '../logger.js';

/**
 * The worker's SSRF allow list, read once.
 *
 * It comes from the environment, not from the instance settings or a permission
 * — the complete reasoning is in `packages/core/src/monitoring.ts`. In short:
 * opening an internal range to monitoring is a deployment decision, made by
 * whoever holds the `.env`, not by whoever clicks on the screen.
 */
let cached: Cidr[] | null = null;

export function allowedCidrs(): readonly Cidr[] {
  if (cached === null) {
    cached = parseCidrList(env.MONITOR_ALLOWED_CIDRS);
    if (cached.length > 0) {
      logger.info(
        { cidrs: cached.map((cidr) => cidr.text) },
        'internal ranges allowed to monitoring',
      );
    }
  }
  return cached;
}
