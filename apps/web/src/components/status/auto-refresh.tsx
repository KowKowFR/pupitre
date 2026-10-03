'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Relit la page au serveur toutes les `seconds` secondes, onglet visible
 * seulement. Une page de statut publique n'a pas de flux temps réel : le canal
 * `pupitre:realtime` est réservé aux sessions, et c'est voulu.
 */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, seconds * 1000);
    return () => window.clearInterval(timer);
  }, [router, seconds]);
  return null;
}
