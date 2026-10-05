import { START_GESTURE, lifecycleRoute } from '../lifecycle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Starts a stopped application again, in the version that was in service. */
export const POST = lifecycleRoute(START_GESTURE);
