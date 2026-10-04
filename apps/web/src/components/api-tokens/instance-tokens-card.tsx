'use client';

import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useT } from '@/i18n/client';
import { apiTokens as messages } from '@/i18n/messages/api-tokens';
import { TokenList, type TokenRow } from './token-list';

/** All the instance's tokens, with their author: what can act without a browser. */
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
