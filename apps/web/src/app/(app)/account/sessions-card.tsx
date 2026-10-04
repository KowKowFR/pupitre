'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { LogOut, Monitor, Smartphone, Tablet } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useT } from '@/i18n/client';
import { account as messages } from '@/i18n/messages/account';
import { toast } from '@/lib/toast';
import { readApiError } from './api-error';

export type SessionRow = {
  id: string;
  current: boolean;
  device: string | null;
  ipAddress: string | null;
  /** "2 d ago", computed at server rendering: the client's clock does not come into it. */
  lastActive: string | null;
};

/** What the confirmation is about to close: one session, or all the others. */
type Target = { kind: 'one'; session: SessionRow } | { kind: 'others' };

/**
 * "Open sessions": the browsers signed in to the account, and what it takes to
 * close those one does not recognize.
 *
 * The current session is named ("this one") and offers no closing: one leaves
 * it through "Sign out", which also cleans the cookie.
 */
/** A device's icon, guessed from the name the agent gave. */
function DeviceIcon({ device }: { device: string | null }) {
  const Icon = /iPad/.test(device ?? '')
    ? Tablet
    : /iPhone|Android/.test(device ?? '')
      ? Smartphone
      : Monitor;
  return (
    <span
      aria-hidden
      className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-surface-2 text-text-2"
    >
      <Icon className="size-4" />
    </span>
  );
}

/** `description`: the sessions' duration, set for the instance, spelled out by the page. */
export function SessionsCard({
  sessions,
  description,
}: {
  sessions: SessionRow[];
  description: string;
}) {
  const t = useT(messages);
  const router = useRouter();
  const [target, setTarget] = useState<Target | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const others = sessions.filter((session) => !session.current);
  const deviceOf = (session: SessionRow) => session.device ?? t('sessions.unknownDevice');

  /** "last active 2 d ago": since when the session was used. */
  function when(session: SessionRow): string | null {
    if (session.current) return t('sessions.activeNow');
    return session.lastActive ? t('sessions.lastActive', { when: session.lastActive }) : null;
  }

  async function confirm(): Promise<void> {
    if (!target) return;
    setPending(true);
    setError(null);

    const response =
      target.kind === 'one'
        ? await fetch(`/api/account/sessions/${encodeURIComponent(target.session.id)}`, {
            method: 'DELETE',
          })
        : await fetch('/api/account/sessions/revoke-others', { method: 'POST' });

    setPending(false);
    if (!response.ok) {
      setError(await readApiError(response, t('error.http', { status: response.status })));
      return;
    }

    const count =
      target.kind === 'one' ? 1 : ((await response.json()) as { revoked: number }).revoked;
    setTarget(null);
    toast({
      title:
        target.kind === 'one' ? t('sessions.closed.one') : t('sessions.closed.others', { count }),
      tone: 'ok',
    });
    router.refresh();
  }

  return (
    <Card>
      <CardHeader
        actions={
          others.length > 0 ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setError(null);
                setTarget({ kind: 'others' });
              }}
            >
              <LogOut aria-hidden />
              {t('sessions.closeOthers')}
            </Button>
          ) : null
        }
      >
        <CardTitle>{t('sessions.title')}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <ul className="list">
        {sessions.map((session) => (
          <li key={session.id} className="flex items-center gap-3">
            <DeviceIcon device={session.device} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium text-text">{deviceOf(session)}</span>
              <span className="t-cap truncate text-text-3">
                {session.ipAddress ? <span className="mono">{session.ipAddress}</span> : null}
                {session.ipAddress && when(session) ? ' · ' : null}
                {when(session)}
              </span>
            </span>
            {session.current ? (
              <Badge variant="ok" dot>
                {t('sessions.badge.current')}
              </Badge>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                aria-label={t('sessions.close.aria', { device: deviceOf(session) })}
                onClick={() => {
                  setError(null);
                  setTarget({ kind: 'one', session });
                }}
              >
                {t('sessions.close')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {others.length === 0 ? (
        <CardContent className="border-t border-border-subtle py-3">
          <p className="t-cap text-text-3">{t('sessions.none')}</p>
        </CardContent>
      ) : null}

      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        level="reversible"
        icon={<LogOut />}
        title={
          target?.kind === 'one'
            ? t('sessions.confirm.one.title', { device: deviceOf(target.session) })
            : t('sessions.confirm.others.title', { count: others.length })
        }
        consequences={[
          target?.kind === 'one'
            ? t('sessions.confirm.signedOut.one')
            : t('sessions.confirm.signedOut.others'),
          t('sessions.confirm.keep'),
          t('sessions.confirm.audit'),
        ]}
        confirmLabel={
          target?.kind === 'one'
            ? t('sessions.confirm.submit.one')
            : t('sessions.confirm.submit.others')
        }
        pendingLabel={t('sessions.closing')}
        pending={pending}
        error={error}
        onConfirm={confirm}
      />
    </Card>
  );
}
