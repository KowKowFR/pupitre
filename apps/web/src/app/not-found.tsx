import Link from 'next/link';
import { AccessCard, AccessShell } from '@/components/access-shell';
import { Button } from '@/components/ui/button';
import { auth as messages } from '@/i18n/messages/auth';
import { getT } from '@/i18n/server';

/**
 * 404 hors de toute section.
 *
 * Sans ce fichier, Next sert sa page par défaut : fond noir, « This page could
 * not be found. » en anglais, aucun lien. Une faute de frappe dans l'URL
 * éjectait donc du panel, sans moyen d'y revenir autrement que par le bouton
 * « précédent ». Elle reprend la forme de `/forbidden` — même carte centrée,
 * même sortie de secours — parce que les deux répondent à la même question :
 * « je suis quelque part où il n'y a rien, comment je rentre ? »
 */
export default async function NotFoundPage() {
  const t = await getT(messages);

  return (
    <AccessShell tagline={t('shell.tagline')}>
      <AccessCard title={t('notFound.title')} description={t('notFound.description')}>
        <p className="t-sm text-text-2">{t('notFound.body')}</p>
        <Button asChild variant="secondary" className="btn-block">
          <Link href="/">{t('link.backToDashboard')}</Link>
        </Button>
      </AccessCard>
    </AccessShell>
  );
}
