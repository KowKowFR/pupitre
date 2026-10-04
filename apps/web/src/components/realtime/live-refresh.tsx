'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import type { LiveTopic } from '@pupitre/core';
import { useOptionalRealtime } from './realtime-provider';

/**
 * A screen that reads itself again when what it shows has moved.
 *
 * It never receives the data through the stream: it learns that a topic changed
 * and asks the server to render the page again — with the session's
 * permissions, as on the first display. The components' state (selection, open
 * drawer, input) survives the refresh.
 *
 * Two guardrails: at most one refresh every few seconds, whatever the signals'
 * pace; and nothing while the tab is hidden — it catches up when coming back to
 * the foreground.
 */
export function LiveRefresh({
  topics = 'all',
  activity = false,
  minIntervalMs = 4_000,
}: {
  topics?: readonly LiveTopic[] | 'all' | 'none';
  /** Also read again at each log line (the log itself). */
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
