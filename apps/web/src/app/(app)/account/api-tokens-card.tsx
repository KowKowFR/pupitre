'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { TokenList, type TokenRow } from '@/components/api-tokens/token-list';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useT } from '@/i18n/client';
import { apiTokens as messages } from '@/i18n/messages/api-tokens';
import type { PermissionGroup } from '../admin/roles/roles-editor';
import { NewTokenDrawer } from './new-token-drawer';

/**
 * « Jetons d'API » sur « Mon compte » : ceux de la personne, et de quoi en
 * créer un. Comme le mot de passe et les sessions, c'est une affaire de soi —
 * mais un jeton ne délègue que les permissions qu'on a.
 */
export function ApiTokensCard({
  rows,
  groups,
  applications,
}: {
  rows: TokenRow[];
  groups: PermissionGroup[];
  applications: Array<{ id: string; name: string }>;
}) {
  const t = useT(messages);
  const [open, setOpen] = useState(false);

  return (
    <Card>
      <CardHeader
        actions={
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            <Plus aria-hidden />
            {t('card.new')}
          </Button>
        }
      >
        <CardTitle>{t('card.title')}</CardTitle>
        <CardDescription>{t('card.description')}</CardDescription>
      </CardHeader>
      <TokenList rows={rows} emptyHint={t('empty.hint')} />
      <NewTokenDrawer
        open={open}
        groups={groups}
        applications={applications}
        onClose={() => setOpen(false)}
      />
    </Card>
  );
}
