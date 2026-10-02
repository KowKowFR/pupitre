'use client';

import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useT } from '@/i18n/client';
import { apiTokens as messages } from '@/i18n/messages/api-tokens';
import { TokenList, type TokenRow } from './token-list';

/** Tous les jetons de l'instance, avec leur auteur : ce qui peut agir sans navigateur. */
export function InstanceTokensCard({ rows }: { rows: TokenRow[] }) {
  const t = useT(messages);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('admin.title')}</CardTitle>
        <CardDescription>{t('admin.description')}</CardDescription>
      </CardHeader>
      <TokenList rows={rows} emptyHint={t('admin.empty.hint')} />
    </Card>
  );
}
