'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/page-header';
import { useT } from '@/i18n/client';
import { auth as messages } from '@/i18n/messages/auth';
import { common } from '@/i18n/messages/common';

/**
 * Filet de rendu du panel.
 *
 * Sans `error.tsx`, une exception jetée pendant le rendu d'une page remonte
 * jusqu'à la racine : en production Next sert une page générique en anglais,
 * sans navigation. Ici l'incident reste **dans** le panel — le rail de gauche
 * répond toujours, et les autres écrans sont à un clic.
 *
 * `digest` est affiché volontairement. En production le message d'origine est
 * masqué par Next pour ne pas fuiter d'interne ; le digest est le seul lien
 * entre ce qu'a vu l'utilisateur et la ligne correspondante dans les logs du
 * serveur. Sans lui, un rapport de bug se réduit à « ça a planté ».
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useT(messages);
  const tc = useT(common);

  useEffect(() => {
    // La console du navigateur garde la trace complète, y compris en
    // développement où le message n'est pas masqué.
    console.error('[panel] erreur de rendu', error);
  }, [error]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('appError.title')}
        description={t('appError.description')}
      />

      <Card className="border-danger-line">
        <CardContent className="space-y-4">
          <Alert variant="destructive">{error.message || t('appError.fallback')}</Alert>

          {error.digest ? (
            <p className="text-xs text-text-3">
              {t('appError.digest.before')}{' '}
              <code className="font-mono text-text-2">{error.digest}</code>{' '}
              {t('appError.digest.after')}
            </p>
          ) : null}

          <div className="flex items-center gap-3">
            {/*
              `reset()` refait le rendu du segment sans recharger la page :
              c'est le bon geste pour une panne passagère (base indisponible le
              temps d'une requête) et il ne coûte rien si l'erreur persiste.
            */}
            <Button onClick={reset}>{tc('retry')}</Button>
            <Link
              href="/"
              className="text-sm text-accent underline decoration-accent-line underline-offset-4 hover:decoration-accent"
            >
              {t('link.backToDashboard')}
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
