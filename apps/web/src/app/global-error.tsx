'use client';

import { useEffect } from 'react';
import { useLanguage, useT } from '@/i18n/client';
import { auth as messages } from '@/i18n/messages/auth';
import { common } from '@/i18n/messages/common';

/**
 * Dernier filet : une erreur jetée par le layout racine lui-même.
 *
 * À ce niveau, ni le layout ni les polices ni la feuille de style ne sont
 * garantis — Next impose donc de rendre `<html>` et `<body>`. Le style est
 * écrit en ligne pour la même raison : si `globals.css` fait partie de ce qui a
 * échoué, une classe utilitaire ne peindrait rien. Les couleurs sont donc
 * fixées en dur, dans les teintes sombres du panel, plutôt que d'hériter d'un
 * fond blanc de navigateur au milieu d'une interface sombre.
 *
 * La langue suit le même sort que le style : c'est le layout racine qui pose le
 * `LanguageProvider`, et c'est lui qui vient d'échouer. `useLanguage()` rend
 * donc la langue par défaut, et `useT()` la langue source. C'est exactement le
 * repli que `renderMessage()` applique partout ailleurs — du français lisible
 * plutôt qu'une clé nue —, et le `lang` du document le dit honnêtement au lieu
 * d'annoncer une langue que le texte ne parle pas.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const language = useLanguage();

  useEffect(() => {
    console.error('[panel] erreur fatale', error);
  }, [error]);

  return (
    <html lang={language}>
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'grid',
          placeItems: 'center',
          background: 'oklch(0.196 0.014 258)',
          color: 'oklch(0.955 0.005 250)',
          fontFamily: 'system-ui, sans-serif',
          padding: '1.5rem',
        }}
      >
        <main style={{ maxWidth: '32rem' }}>
          <h1 style={{ fontSize: '1.125rem', margin: '0 0 0.5rem' }}>{t('globalError.title')}</h1>
          <p style={{ margin: '0 0 1rem', color: 'oklch(0.712 0.018 254)', fontSize: '0.875rem' }}>
            {t('globalError.body')}
          </p>
          {error.digest ? (
            <p style={{ margin: '0 0 1rem', fontSize: '0.75rem', color: 'oklch(0.588 0.018 254)' }}>
              {t('globalError.reference')} <code>{error.digest}</code>
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            style={{
              cursor: 'pointer',
              border: 0,
              borderRadius: '0.375rem',
              padding: '0.5rem 0.875rem',
              fontSize: '0.875rem',
              background: 'oklch(0.742 0.104 212)',
              color: 'oklch(0.184 0.032 240)',
            }}
          >
            {tc('retry')}
          </button>
        </main>
      </body>
    </html>
  );
}
