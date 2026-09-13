import { STOP_GESTURE, lifecycleRoute } from '../lifecycle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Arrête une application en marche. Les processus s'arrêtent, les volumes, le
 * port réservé et l'entrée de proxy restent en place : c'est `start` qui remet
 * tout en marche, pas un redéploiement.
 */
export const POST = lifecycleRoute(STOP_GESTURE);
