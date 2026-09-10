'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

type Enqueued = { jobId: string };

export function PingButton() {
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function enqueue() {
    setPending(true);
    setStatus(null);
    try {
      const response = await fetch('/api/ping', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'ping depuis le panel' }),
      });
      const body = (await response.json()) as Enqueued;
      const poll = await fetch(`/api/ping/${body.jobId}`, { cache: 'no-store' });
      const job = (await poll.json()) as { state: string };
      setStatus(`job ${body.jobId} → ${job.state}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'échec');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <Button onClick={() => void enqueue()} disabled={pending} size="sm">
        {pending ? 'Envoi…' : 'Enfiler un ping'}
      </Button>
      {status ? (
        <span className="rounded-sm border border-line bg-surface-2 px-2 py-1 font-mono text-[0.6875rem] text-ink-muted">
          {status}
        </span>
      ) : null}
    </div>
  );
}
