'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { KeyValue } from '@/components/ui/data';
import { useT } from '@/i18n/client';
import { account as messages } from '@/i18n/messages/account';
import { toast } from '@/lib/toast';
import { readApiError } from './api-error';

export type SessionRow = {
  id: string;
  current: boolean;
  device: string | null;
  ipAddress: string | null;
  /** « il y a 2 j », calculé au rendu serveur : l'horloge du client n'y entre pas. */
  lastActive: string | null;
};

/** Ce que la confirmation s'apprête à fermer : une session, ou toutes les autres. */
type Target = { kind: 'one'; session: SessionRow } | { kind: 'others' };

/**
 * « Sessions ouvertes » : les navigateurs connectés au compte, et de quoi
 * fermer ceux qu'on ne reconnaît pas.
 *
 * La session courante est nommée (« celle-ci ») et ne propose aucune
 * fermeture : on la quitte par « Déconnexion », qui nettoie aussi le cookie.
 */
export function SessionsCard({
  sessions,
  lastSignIn,
}: {
  sessions: SessionRow[];
  /** Dernière connexion réussie, déjà mise en forme : date, méthode, IP. */
  lastSignIn: string | null;
}) {
  const t = useT(messages);
  const router = useRouter();
  const [target, setTarget] = useState<Target | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const others = sessions.filter((session) => !session.current);
  const deviceOf = (session: SessionRow) => session.device ?? t('sessions.unknownDevice');

  function describe(session: SessionRow): string {
    return [deviceOf(session), session.ipAddress, session.current ? null : session.lastActive]
      .filter((part): part is string => Boolean(part))
      .join(' · ');
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
        <CardDescription>{t('sessions.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <KeyValue
          items={sessions
            .map((session) => ({
              key: session.id,
              term: session.current ? t('sessions.current') : t('sessions.other'),
              value: (
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0">
                    {describe(session)}
                    {session.current ? (
                      <>
                        {' · '}
                        <span className="font-medium text-ok-text">{t('sessions.this')}</span>
                      </>
                    ) : null}
                  </span>
                  {session.current ? null : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto"
                      aria-label={t('sessions.close.aria', { device: deviceOf(session) })}
                      onClick={() => {
                        setError(null);
                        setTarget({ kind: 'one', session });
                      }}
                    >
                      {t('sessions.close')}
                    </Button>
                  )}
                </span>
              ),
            }))
            .concat(
              lastSignIn
                ? [
                    {
                      key: 'last-sign-in',
                      term: t('sessions.lastSignIn'),
                      value: <span className="mono t-sm">{lastSignIn}</span>,
                    },
                  ]
                : [],
            )}
        />
        {others.length === 0 ? <p className="t-sm mt-3 text-text-3">{t('sessions.none')}</p> : null}
      </CardContent>

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
