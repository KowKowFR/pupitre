'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';

type JobState = {
  state: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused' | 'unknown';
  failedReason: string | null;
};

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 120_000;

/**
 * Lance un preflight et suit la tâche BullMQ jusqu'à son terme, puis
 * rafraîchit les données du Server Component. C'est ce qui fait apparaître
 * « Docker ✓ / K3s ✗ » sans rechargement manuel.
 */
export function usePreflight({ onError }: { onError: (message: string | null) => void }) {
  const router = useRouter();
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
      setPhase(targetId, 'enfilé…');

      try {
        const enqueue = await fetch(`/api/targets/${targetId}/preflight`, { method: 'POST' });
        if (!enqueue.ok) {
          const body = (await enqueue.json().catch(() => ({}))) as {
            error?: { message?: string };
          };
          throw new Error(body.error?.message ?? `Échec (HTTP ${enqueue.status})`);
        }

        const { jobId } = (await enqueue.json()) as { jobId: string };
        const deadline = Date.now() + POLL_TIMEOUT_MS;

        for (;;) {
          if (Date.now() > deadline) throw new Error('Le preflight ne répond pas (timeout)');
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

          const poll = await fetch(`/api/queue/jobs/${jobId}`, { cache: 'no-store' });
          if (!poll.ok) throw new Error(`Suivi de tâche impossible (HTTP ${poll.status})`);

          const job = (await poll.json()) as JobState;
          if (job.state === 'completed') {
            setPhase(targetId, 'terminé');
            router.refresh();
            // Laisse le rafraîchissement serveur remplacer la mention.
            setTimeout(() => setPhase(targetId, null), 1500);
            return;
          }
          if (job.state === 'failed') {
            throw new Error(job.failedReason ?? 'Le preflight a échoué');
          }
          setPhase(targetId, job.state === 'active' ? 'connexion SSH…' : 'en attente…');
        }
      } catch (error) {
        onError(error instanceof Error ? error.message : 'Le preflight a échoué');
        setPhase(targetId, null);
      } finally {
        running.current.delete(targetId);
      }
    },
    [onError, router, setPhase],
  );

  return {
    run,
    phaseOf: (targetId: string) => phases[targetId] ?? null,
    isRunning: (targetId: string) => phases[targetId] !== undefined,
  };
}
