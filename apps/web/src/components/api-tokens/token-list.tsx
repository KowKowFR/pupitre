'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import type { Translate } from '@pupitre/core';
import { EmptyState } from '@/components/empty-state';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useT } from '@/i18n/client';
import { apiTokens as messages } from '@/i18n/messages/api-tokens';
import { common } from '@/i18n/messages/common';
import { toast } from '@/lib/toast';

/**
 * Un jeton tel que la liste l'affiche. Les dates arrivent déjà écrites : elles
 * sont formatées au rendu serveur, à la locale de l'instance, et l'horloge du
 * navigateur n'y entre pas.
 */
export type TokenRow = {
  id: string;
  name: string;
  prefix: string;
  status: 'active' | 'revoked' | 'expired';
  permissions: number;
  /** Les noms des applications couvertes, `null` pour toutes. */
  applications: string[] | null;
  created: string;
  expires: string | null;
  lastUsed: string | null;
  lastUsedIp: string | null;
  /** L'auteur, sur la liste de l'instance ; absent sur sa propre liste. */
  owner?: string;
};

const STATUS_VARIANT: Record<TokenRow['status'], BadgeProps['variant']> = {
  active: 'ok',
  revoked: 'outline',
  expired: 'warn',
};

/**
 * La liste des jetons : ce que chacun peut, sur quoi, depuis quand et jusqu'à
 * quand, et sa dernière utilisation. Un jeton actif se révoque d'ici.
 */
export function TokenList({ rows, emptyHint }: { rows: TokenRow[]; emptyHint: string }) {
  const t = useT(messages);
  const c = useT(common);
  const router = useRouter();
  const [revoking, setRevoking] = useState<TokenRow | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke(): Promise<void> {
    if (!revoking) return;
    setPending(true);
    setError(null);
    const response = await fetch(`/api/tokens/${encodeURIComponent(revoking.id)}`, {
      method: 'DELETE',
    });
    setPending(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(body?.error?.message ?? c('http.failure', { status: response.status }));
      return;
    }
    toast({ title: t('revoke.done', { name: revoking.name }), tone: 'ok' });
    setRevoking(null);
    router.refresh();
  }

  if (rows.length === 0) {
    return <EmptyState icon={KeyRound} title={t('empty.title')} hint={emptyHint} />;
  }

  return (
    <>
      <ul className="list">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center gap-3">
            <span
              aria-hidden
              className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-surface-2 text-text-2"
            >
              <KeyRound className="size-4" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span className="truncate font-medium text-text">{row.name}</span>
                <span className="mono t-cap text-text-3">{row.prefix}…</span>
              </span>
              <span className="t-cap text-text-3">{describe(row, t)}</span>
            </span>
            <Badge variant={STATUS_VARIANT[row.status]} dot>
              {t(`status.${row.status}`)}
            </Badge>
            {row.status === 'active' ? (
              <Button
                size="sm"
                variant="ghost"
                aria-label={t('row.revokeLabel', { name: row.name })}
                onClick={() => {
                  setError(null);
                  setRevoking(row);
                }}
              >
                {t('row.revoke')}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        level="trace"
        icon={<KeyRound />}
        title={t('revoke.title', { name: revoking?.name ?? '' })}
        consequences={[t('revoke.description')]}
        confirmLabel={t('revoke.confirm')}
        pending={pending}
        error={error}
        onConfirm={revoke}
      />
    </>
  );
}

/** « 3 permissions · toutes les applications · créé le … · utilisé il y a 2 min depuis … » */
function describe(row: TokenRow, t: Translate<typeof messages.fr>): string {
  const parts = [
    row.owner ? t('row.owner', { name: row.owner }) : null,
    t('row.permissions', { count: row.permissions }),
    row.applications ? row.applications.join(', ') : t('row.applications.all'),
    t('row.created', { date: row.created }),
    row.expires
      ? t(row.status === 'expired' ? 'row.expired' : 'row.expires', { date: row.expires })
      : t('row.noExpiry'),
    row.lastUsed
      ? row.lastUsedIp
        ? t('row.lastUsedFrom', { when: row.lastUsed, ip: row.lastUsedIp })
        : t('row.lastUsed', { when: row.lastUsed })
      : t('row.neverUsed'),
  ];
  return parts.filter(Boolean).join(' · ');
}
