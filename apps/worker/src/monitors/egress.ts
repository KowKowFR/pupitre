import { createCaptureEgress, type CaptureEgress } from '@pupitre/core/capture';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { captureEnabled } from './capture.js';
import { allowedCidrs } from './policy.js';

/**
 * The proxy through which the capture browser goes out — life cycle.
 *
 * Opened **only** when capture is configured: an instance that wants none opens
 * no extra port. Its reason for being and the measurement that made it necessary
 * are in `packages/core/src/capture/egress.ts` — in two lines: two distinct
 * Docker networks are **not** isolated from each other, only `internal: true`
 * is, and an internal network also cuts the Internet. The proxy is the door, and
 * the SSRF guard is its doorkeeper.
 */

let egress: CaptureEgress | null = null;

export async function startCaptureEgress(): Promise<void> {
  if (!captureEnabled()) {
    logger.debug('capture disabled — no egress proxy opened');
    return;
  }
  egress = await createCaptureEgress({
    allowlist: allowedCidrs(),
    port: env.MONITOR_CAPTURE_EGRESS_PORT,
    onBlocked: (target, reason) => {
      // The refusal is **the** trace that matters: a monitored page tried to reach
      // something other than its own public origin. Never silently.
      logger.warn({ target, reason }, 'capture browser egress refused');
    },
  });
  logger.info(
    { port: egress.port, cdp: env.MONITOR_CAPTURE_CDP_URL },
    'capture browser egress proxy open',
  );
}

export async function stopCaptureEgress(): Promise<void> {
  if (!egress) return;
  await egress.close();
  egress = null;
}
