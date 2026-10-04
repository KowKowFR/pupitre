'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Reads the page again from the server every `seconds` seconds, visible tab only.
 * A public status page has no real-time stream: the `pupitre:realtime` channel is
 * reserved for sessions, and that is on purpose.
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
