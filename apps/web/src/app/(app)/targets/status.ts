import type { TargetHealth } from '@pupitre/core';
import type { Tone } from '@/components/ui/led';

/**
 * Le ton de chaque état de cible. Module neutre — ni client ni serveur — pour
 * que la liste (client) et la fiche (serveur) lisent la même table : un
 * composant serveur qui importe une constante d'un module client ne reçoit
 * qu'une référence opaque.
 */
export const STATUS_TONE: Record<TargetHealth, Tone> = {
  ok: 'ok',
  degraded: 'warn',
  unreachable: 'danger',
  unknown: 'idle',
};
