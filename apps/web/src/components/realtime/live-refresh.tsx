'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import type { LiveTopic } from '@pupitre/core';
import { useOptionalRealtime } from './realtime-provider';

/**
 * Un écran qui se relit tout seul quand ce qu'il montre a bougé.
 *
 * Il ne reçoit jamais les données par le flux : il apprend qu'un sujet a
 * changé et demande au serveur de rendre la page à nouveau — avec les
 * permissions de la session, comme au premier affichage. L'état des
 * composants (sélection, tiroir ouvert, saisie) survit au rafraîchissement.
 *
 * Deux garde-fous : au plus un rafraîchissement toutes les quelques secondes,
 * quelle que soit la cadence des signaux ; et rien tant que l'onglet est caché
 * — il se rattrape en revenant au premier plan.
 */
export function LiveRefresh({
  topics = 'all',
  activity = false,
  minIntervalMs = 4_000,
}: {
  topics?: readonly LiveTopic[] | 'all' | 'none';
  /** Se relire aussi à chaque ligne du journal (le journal lui-même). */
  activity?: boolean;
  minIntervalMs?: number;
}) {
  const realtime = useOptionalRealtime();
  const subscribe = realtime?.subscribe;
  const router = useRouter();
  const key: string = typeof topics === 'string' ? topics : topics.join(',');

  useEffect(() => {
    if (!subscribe) return;
    const wanted = key === 'all' || key === 'none' ? key : new Set(key.split(','));
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending = false;

    const run = () => {
      timer = null;
      if (document.visibilityState !== 'visible') {
        pending = true;
        return;
      }
      pending = false;
      last = Date.now();
      router.refresh();
    };
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(run, Math.max(0, last + minIntervalMs - Date.now()));
    };

    const offLive = subscribe('live', (event) => {
      if (wanted === 'all' || (wanted !== 'none' && wanted.has(event.topic))) schedule();
    });
    const offActivity = activity ? subscribe('activity', () => schedule()) : () => undefined;
    const onVisible = () => {
      if (pending && document.visibilityState === 'visible') schedule();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      offLive();
      offActivity();
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [subscribe, router, key, activity, minIntervalMs]);

  return null;
}
