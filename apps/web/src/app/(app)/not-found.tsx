import Link from 'next/link';
import { AccessCard } from '@/components/access-shell';
import { Button } from '@/components/ui/button';
import { auth as messages } from '@/i18n/messages/auth';
import { getT } from '@/i18n/server';

/**
 * 404 **dans** le panel — celle que rend un `notFound()` appelé depuis une
 * page de section, typiquement un identifiant qui n'existe plus en base.
 *
 * Elle existe séparément de `app/not-found.tsx` pour une seule raison : rendue
 * ici, elle garde le rail de navigation. Perdre la navigation parce qu'un
 * déploiement a été purgé serait une punition disproportionnée.
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
