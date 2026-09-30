import Link from 'next/link';
import { AccessCard, AccessShell } from '@/components/access-shell';
import { Button } from '@/components/ui/button';
import { auth as messages } from '@/i18n/messages/auth';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

export default async function ForbiddenPage({
  searchParams,
}: {
  searchParams: Promise<{ permission?: string }>;
}) {
  const { permission } = await searchParams;
  const t = await getT(messages);

  return (
    <AccessShell tagline={t('shell.tagline')}>
      <AccessCard
        tone="danger"
        title={t('forbidden.title')}
        description={t('forbidden.description')}
      >
        {permission ? (
          <div className="well t-sm">
            {t('forbidden.permission')} <code className="mono">{permission}</code>
          </div>
        ) : null}
        <p className="t-cap text-text-3">{t('forbidden.body')}</p>
        <Button asChild variant="secondary" className="btn-block">
          <Link href="/">{t('link.backToDashboard')}</Link>
        </Button>
      </AccessCard>
    </AccessShell>
  );
}
