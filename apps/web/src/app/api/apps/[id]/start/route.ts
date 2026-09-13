import { START_GESTURE, lifecycleRoute } from '../lifecycle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Remet en marche une application arrêtée, dans la version qui était en service. */
export const POST = lifecycleRoute(START_GESTURE);
