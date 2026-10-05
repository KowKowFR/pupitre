'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { targets } from '@/i18n/messages/targets';

type JobState = {
  state: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused' | 'unknown';
  failedReason: string | null;
};

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 120_000;

/**
 * Starts a preflight and follows the BullMQ job until it ends, then refreshes the
 * Server Component's data. That is what makes "Docker ✓ / K3s ✗" appear without a
 * manual reload.
 */
export function usePreflight({ onError }: { onError: (message: string | null) => void }) {
  const router = useRouter();
  const t = useT(targets);
  const tc = useT(common);
  const [phases, setPhases] = useState<Record<string, string>>({});
  const running = useRef(new Set<string>());

  const setPhase = useCallback((targetId: string, phase: string | null) => {
    setPhases((current) => {
      const next = { ...current };
      if (phase === null) delete next[targetId];
      else next[targetId] = phase;
      return next;
    });
  }, []);

  const run = useCallback(
    async (targetId: string) => {
      if (running.current.has(targetId)) return;
      running.current.add(targetId);
      onError(null);
      setPhase(targetId, t('phase.queued'));

      try {
        const enqueue = await fetch(`/api/targets/${targetId}/preflight`, { method: 'POST' });
        if (!enqueue.ok) {
          const body = (await enqueue.json().catch(() => ({}))) as {
            error?: { message?: string };
          };
          throw new Error(body.error?.message ?? tc('http.failure', { status: enqueue.status }));
        }

        const { jobId } = (await enqueue.json()) as { jobId: string };
        const deadline = Date.now() + POLL_TIMEOUT_MS;

        for (;;) {
          if (Date.now() > deadline) throw new Error(t('preflight.error.timeout'));
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

          const poll = await fetch(`/api/queue/jobs/${jobId}`, { cache: 'no-store' });
          if (!poll.ok) throw new Error(t('preflight.error.poll', { status: poll.status }));

          const job = (await poll.json()) as JobState;
          if (job.state === 'completed') {
            setPhase(targetId, t('phase.done'));
            router.refresh();
            // Lets the server refresh replace the mention.
            setTimeout(() => setPhase(targetId, null), 1500);
            return;
          }
          if (job.state === 'failed') {
            throw new Error(job.failedReason ?? t('preflight.error.failed'));
          }
          setPhase(targetId, job.state === 'active' ? t('phase.ssh') : t('phase.waiting'));
        }
      } catch (error) {
        onError(error instanceof Error ? error.message : t('preflight.error.failed'));
        setPhase(targetId, null);
      } finally {
        running.current.delete(targetId);
      }
    },
    [onError, router, setPhase, t, tc],
  );

  return {
    run,
    phaseOf: (targetId: string) => phases[targetId] ?? null,
    isRunning: (targetId: string) => phases[targetId] !== undefined,
  };
}
