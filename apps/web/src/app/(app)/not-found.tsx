import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/page-header';
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
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('appNotFound.title')}
        description={t('appNotFound.description')}
      />
      <Card>
        <CardContent className="space-y-3">
          <p className="text-[0.8125rem] text-text-2">{t('appNotFound.body')}</p>
          <Link
            href="/"
            className="inline-block text-sm text-accent underline decoration-accent-line underline-offset-4 hover:decoration-accent"
          >
            {t('link.backToDashboard')}
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
