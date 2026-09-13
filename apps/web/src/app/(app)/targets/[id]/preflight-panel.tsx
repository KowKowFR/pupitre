'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { targets as messages } from '@/i18n/messages/targets';
import { usePreflight } from '../use-preflight';

export function PreflightPanel({
  targetId,
  canRunPreflight,
  canEdit,
}: {
  targetId: string;
  canRunPreflight: boolean;
  canEdit: boolean;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const [error, setError] = useState<string | null>(null);
  const { run, phaseOf, isRunning } = usePreflight({ onError: setError });
  const phase = phaseOf(targetId);

  return (
    <div className="flex flex-col gap-2.5">
      {error ? <Alert variant="destructive">{error}</Alert> : null}

      {canRunPreflight ? (
        <Button
          className="w-full"
          disabled={isRunning(targetId)}
          onClick={() => void run(targetId)}
        >
          {isRunning(targetId) ? t('action.testing') : t('action.test')}
        </Button>
      ) : null}

      {phase ? (
        <p className="flex items-center gap-1.5 text-xs text-signal">
          <span className="size-1.5 animate-signal-pulse rounded-full bg-signal" />
          {phase}
        </p>
      ) : null}

      {canEdit ? (
        <Button asChild variant="outline" size="sm" className="w-full">
          <Link href={`/targets/${targetId}/edit`}>{tc('edit')}</Link>
        </Button>
      ) : null}
    </div>
  );
}
