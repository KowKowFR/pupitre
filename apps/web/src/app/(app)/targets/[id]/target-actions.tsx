'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Ellipsis, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { State } from '@/components/ui/led';
import { IconButton } from '@/components/ui/tooltip';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { targets as messages } from '@/i18n/messages/targets';
import { toast } from '@/lib/toast';
import { usePreflight } from '../use-preflight';

/**
 * Les gestes de la fiche d'une cible, en tête de page : Modifier, Tester la
 * connexion — l'action primaire — et un menu pour le reste. La suppression y
 * est la dernière entrée, en rouge ; quand l'API la refuserait, l'entrée est
 * inactive et la raison est écrite dessous, dans le menu même.
 */
export function TargetActions({
  target,
  canRunPreflight,
  canEdit,
  canDelete,
  deleteBlockedReason,
}: {
  target: { id: string; name: string; host: string };
  canRunPreflight: boolean;
  canEdit: boolean;
  canDelete: boolean;
  deleteBlockedReason: string | null;
}) {
  const router = useRouter();
  const t = useT(messages);
  const tc = useT(common);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const { run, phaseOf, isRunning } = usePreflight({ onError: setError });
  const phase = phaseOf(target.id);

  function test() {
    toast({
      title: t('toast.preflight.title', { name: target.name }),
      description: t('toast.preflight.detail'),
      tone: 'accent',
    });
    void run(target.id);
  }

  async function remove() {
    setPending(true);
    setDeleteError(null);
    const response = await fetch(`/api/targets/${target.id}`, { method: 'DELETE' });
    setPending(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      setDeleteError(body.error?.message ?? tc('http.failure', { status: response.status }));
      return;
    }
    toast({ title: t('toast.deleted', { name: target.name }), tone: 'ok' });
    router.push('/targets');
  }

  return (
    <>
      {phase ? (
        <State tone="accent" pulse>
          {phase}
        </State>
      ) : null}
      {canEdit ? (
        <Button variant="secondary" asChild>
          <Link href={`/targets/${target.id}/edit`}>
            <Pencil aria-hidden />
            {tc('edit')}
          </Link>
        </Button>
      ) : null}
      {canRunPreflight ? (
        <Button loading={isRunning(target.id)} onClick={test}>
          {isRunning(target.id) ? null : <RefreshCw aria-hidden />}
          {isRunning(target.id) ? t('action.testing') : t('action.test')}
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label={t('detail.more')} variant="secondary">
            <Ellipsis />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[260px]">
          <DropdownMenuItem asChild>
            <Link href={`/targets?target=${encodeURIComponent(target.name)}`}>{t('detail.preview')}</Link>
          </DropdownMenuItem>
          {canDelete ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                destructive
                disabled={deleteBlockedReason !== null}
                onSelect={() => {
                  setDeleteError(null);
                  setConfirming(true);
                }}
              >
                <Trash2 aria-hidden />
                {t('detail.delete')}
              </DropdownMenuItem>
              {deleteBlockedReason ? (
                <DropdownMenuLabel className="font-normal">{deleteBlockedReason}</DropdownMenuLabel>
              ) : null}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {error ? (
        <Alert variant="destructive" className="basis-full">
          {error}
        </Alert>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        level="trace"
        title={t('delete.title', { name: target.name })}
        consequences={[
          t('delete.consequence.key'),
          t('delete.consequence.machine', { host: target.host }),
          t('delete.consequence.audit'),
        ]}
        confirmLabel={t('delete.confirm')}
        pendingLabel={tc('deleting')}
        pending={pending}
        error={deleteError}
        onConfirm={remove}
      />
    </>
  );
}
