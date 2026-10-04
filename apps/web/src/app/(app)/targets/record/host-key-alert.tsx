'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { targets as messages } from '@/i18n/messages/targets';
import { toast } from '@/lib/toast';

/**
 * The target presented another host key than the kept one: Pupitre refuses to
 * connect to it until someone has decided. Visible on every tab — nothing works
 * on this machine any more, it must be seen.
 */
export function HostKeyAlert({
  target,
  expected,
  presented,
  since,
  canDecide,
}: {
  target: { id: string; name: string };
  expected: string | null;
  presented: string;
  /** The date, already formatted. */
  since: string;
  canDecide: boolean;
}) {
  const router = useRouter();
  const t = useT(messages);
  const tc = useT(common);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<'accept' | 'dismiss' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: 'accept' | 'dismiss') {
    setBusy(decision);
    setError(null);
    const response = await fetch(`/api/targets/${target.id}/host-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision }),
    }).catch(() => null);
    setBusy(null);
    if (!response?.ok) {
      const body = response
        ? ((await response.json().catch(() => ({}))) as { error?: { message?: string } })
        : {};
      setError(body.error?.message ?? tc('http.failure', { status: response?.status ?? 0 }));
      return;
    }
    toast({
      title: decision === 'accept' ? t('hostKey.accepted') : t('hostKey.dismissed'),
      tone: decision === 'accept' ? 'ok' : 'accent',
    });
    router.refresh();
  }

  return (
    <Alert variant="destructive" title={t('hostKey.changed.title')}>
      <div className="mt-1 flex flex-col gap-2">
        <span>{t('hostKey.changed.body', { date: since })}</span>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[13px]">
          <dt>{t('hostKey.expected')}</dt>
          <dd className="mono break-all">{expected ?? '—'}</dd>
          <dt>{t('hostKey.presented')}</dt>
          <dd className="mono break-all">{presented}</dd>
        </dl>
        <span className="t-cap">{t('hostKey.changed.verify')}</span>
        {error ? <span>{error}</span> : null}
        {canDecide ? (
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              size="sm"
              variant="destructive"
              loading={busy === 'accept'}
              onClick={() => setConfirming(true)}
            >
              {t('hostKey.accept')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              loading={busy === 'dismiss'}
              onClick={() => void decide('dismiss')}
            >
              {t('hostKey.dismiss')}
            </Button>
          </div>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        level="reversible"
        title={t('hostKey.accept.title', { target: target.name })}
        consequences={[t('hostKey.accept.consequence')]}
        confirmLabel={t('hostKey.accept')}
        onConfirm={async () => {
          setConfirming(false);
          await decide('accept');
        }}
      />
    </Alert>
  );
}
