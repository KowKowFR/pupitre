import { STOP_GESTURE, lifecycleRoute } from '../lifecycle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Stops a running application. The processes stop, the volumes, the reserved
 * port and the proxy entry stay in place: it is `start` that brings everything
 * back up, not a redeployment.
 */
export const POST = lifecycleRoute(STOP_GESTURE);
