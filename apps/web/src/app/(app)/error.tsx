'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/page-header';

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
  useEffect(() => {
    // La console du navigateur garde la trace complète, y compris en
    // développement où le message n'est pas masqué.
    console.error('[panel] erreur de rendu', error);
  }, [error]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Incident"
        title="Cet écran n'a pas pu s'afficher"
        description="Le reste du panel continue de fonctionner."
      />

      <Card className="border-danger-edge">
        <CardContent className="space-y-4">
          <Alert variant="destructive">
            {error.message || 'Erreur inattendue pendant le rendu de la page.'}
          </Alert>

          {error.digest ? (
            <p className="text-xs text-ink-faint">
              Référence à citer dans un rapport :{' '}
              <code className="font-mono text-ink-muted">{error.digest}</code> — elle se retrouve
              dans les logs du serveur.
            </p>
          ) : null}

          <div className="flex items-center gap-3">
            {/*
              `reset()` refait le rendu du segment sans recharger la page :
              c'est le bon geste pour une panne passagère (base indisponible le
              temps d'une requête) et il ne coûte rien si l'erreur persiste.
            */}
            <Button onClick={reset}>Réessayer</Button>
            <Link
              href="/"
              className="text-sm text-signal underline decoration-signal-edge underline-offset-4 hover:decoration-signal"
            >
              Retour au tableau de bord
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
