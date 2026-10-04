import Link from 'next/link';
import { AccessCard } from '@/components/access-shell';
import { Button } from '@/components/ui/button';
import { auth as messages } from '@/i18n/messages/auth';
import { getT } from '@/i18n/server';

/**
 * A 404 **inside** the panel — the one a `notFound()` called from a section page
 * renders, typically an identifier that no longer exists in the database.
 *
 * It exists separately from `app/not-found.tsx` for a single reason: rendered
 * here, it keeps the navigation rail. Losing the navigation because a deployment
 * was purged would be a disproportionate punishment.
 */
export default async function AppNotFound() {
  const t = await getT(messages);

  return (
    <div className="mx-auto mt-6 w-full max-w-[440px]">
      <AccessCard title={t('appNotFound.title')} description={t('appNotFound.description')}>
        <p className="t-sm text-text-2">{t('appNotFound.body')}</p>
        <Button asChild variant="secondary" className="btn-block">
          <Link href="/">{t('link.backToDashboard')}</Link>
        </Button>
      </AccessCard>
    </div>
  );
}
