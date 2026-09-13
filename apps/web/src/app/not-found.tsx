import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
    <div className="mx-auto flex min-h-dvh max-w-md items-center p-6">
      <Card className="w-full shadow-raised">
        <CardHeader>
          <CardTitle className="text-lg">{t('notFound.title')}</CardTitle>
          <CardDescription>{t('notFound.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-[0.8125rem] text-ink-muted">{t('notFound.body')}</p>
          <Link
            href="/"
            className="text-sm text-signal underline decoration-signal-edge underline-offset-4 hover:decoration-signal"
          >
            {t('link.backToDashboard')}
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
