'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { HostMetrics, Translate } from '@pupitre/core';
import { useT } from '@/i18n/client';
import { servers } from '@/i18n/messages/servers';

/**
 * Reading host metrics, browser side.
 *
 * ### When the reading goes out
 *
 * **When the screen loads, not when the disclosure opens.** A monitoring screen
 * that shows nothing until one clicks does not monitor: the load and the disk
 * must be readable at a glance, without opening anything. The disclosure, for its
 * part, only contains the list of applications — it comes from the database, it
 * is already rendered, opening it therefore costs no request.
 *
 * ### Why ten machines do not make ten SSH sessions
 *
 * The readings are queued on the client side and run **two at a time**. Ten
 * targets make five waves of about a second, not ten simultaneous sessions — and
 * the worker keeps its monitoring slots for the log streams.
 *
 * ### Why no automatic refresh
 *
 * An interval would turn a forgotten tab into a permanent probe: each reading
 * opens a real SSH session on a real machine. The reading therefore shows its age
 * ("2 min ago"), which grows older before the reader's eyes, and is requested
 * again with a button — per server or for the whole list. It is the reader who
 * decides to pay, never the page.
 */

export type MetricsEntry =
  | { state: 'loading' }
  | { state: 'ready'; metrics: HostMetrics; at: number }
  | { state: 'error'; message: string; at: number };

type ApiError = { error?: { message?: string } };

/** Simultaneous readings. Two: enough for the list to fill quickly, few enough
 *  that an open screen does not become a burst of SSH connections. */
const CONCURRENCY = 2;

/**
 * Bare query. Outside the component, hence stable: it touches no state and can be
 * called from an effect without causing a render.
 *
 * The `t` is passed as an argument rather than read here: the function stays
 * outside the component, and that is what allows it to be called from an effect
 * without entering its dependencies.
 */
async function probeOnce(targetId: string, t: Translate<typeof servers.fr>): Promise<MetricsEntry> {
  try {
    const response = await fetch(`/api/targets/${targetId}/metrics`, { cache: 'no-store' });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      return {
        state: 'error',
        message: body.error?.message ?? t('readout.failed.http', { status: response.status }),
        at: Date.now(),
      };
    }
    return { state: 'ready', metrics: (await response.json()) as HostMetrics, at: Date.now() };
  } catch {
    return { state: 'error', message: t('panel.unreachable'), at: Date.now() };
  }
}

export function useHostMetrics(targetIds: string[], enabled: boolean) {
  const t = useT(servers);
  const [entries, setEntries] = useState<Record<string, MetricsEntry>>({});
  // Targets already read at least once: the first reading is not replayed at each
  // `router.refresh()` triggered by an action on the page.
  const requested = useRef(new Set<string>());

  // `targetIds` is a new array at each render: we depend on its content.
  const idsKey = targetIds.join(',');

  useEffect(() => {
    if (!enabled) return;

    const asked = requested.current;
    const pending = idsKey.split(',').filter((id) => id !== '' && !asked.has(id));
    if (pending.length === 0) return;
    for (const id of pending) asked.add(id);

    let cancelled = false;
    const queue = [...pending];
    const landed = new Set<string>();

    // No `setState` before the first `await`: the first render shows "reading in
    // progress" through the absence of an entry, not through a state set here.
    void Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        for (;;) {
          const id = queue.shift();
          if (id === undefined) return;
          const entry = await probeOnce(id, t);
          if (cancelled) return;
          landed.add(id);
          setEntries((current) => ({ ...current, [id]: entry }));
        }
      }),
    );

    return () => {
      cancelled = true;
      // A cancelled effect gives back the targets whose reading has not arrived:
      // without that, strict mode's double mount marked them "requested" then threw
      // away their answer, and the band stayed "in progress" forever.
      for (const id of pending) if (!landed.has(id)) asked.delete(id);
    };
  }, [idsKey, enabled, t]);

  /** Requests a reading again. Called from an event handler, never from an effect. */
  const refresh = useCallback(
    async (targetId: string) => {
      requested.current.add(targetId);
      setEntries((current) => ({ ...current, [targetId]: { state: 'loading' } }));
      const entry = await probeOnce(targetId, t);
      setEntries((current) => ({ ...current, [targetId]: entry }));
    },
    [t],
  );

  const refreshAll = useCallback(async () => {
    const ids = idsKey.split(',').filter((id) => id !== '');
    if (ids.length === 0) return;

    for (const id of ids) requested.current.add(id);
    setEntries(Object.fromEntries(ids.map((id) => [id, { state: 'loading' as const }])));

    const queue = [...ids];
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        for (;;) {
          const id = queue.shift();
          if (id === undefined) return;
          const entry = await probeOnce(id, t);
          setEntries((current) => ({ ...current, [id]: entry }));
        }
      }),
    );
  }, [idsKey, t]);

  return { entries, refresh, refreshAll };
}
