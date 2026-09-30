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

  // Page minimale aux styles en ligne : à ce stade, aucune feuille de style
  // n'est garantie. Les couleurs sont celles du thème clair, écrites en dur.
  return (
    <html lang={language}>
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'grid',
          placeItems: 'center',
          background: '#f7f8fa',
          color: '#14161b',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          padding: '24px',
        }}
      >
        <main
          style={{
            width: '100%',
            maxWidth: '400px',
            boxSizing: 'border-box',
            background: '#ffffff',
            border: '1px solid #e3e6ec',
            borderRadius: '14px',
            boxShadow: '0 4px 12px rgba(20, 22, 27, 0.08)',
            padding: '28px',
          }}
        >
          <h1 style={{ fontSize: '20px', lineHeight: '28px', fontWeight: 600, margin: '0 0 6px' }}>
            {t('globalError.title')}
          </h1>
          <p style={{ margin: '0 0 12px', color: '#4b5160', fontSize: '14px', lineHeight: '20px' }}>
            {t('globalError.body')}
          </p>
          {error.digest ? (
            <p style={{ margin: '0 0 16px', fontSize: '12px', color: '#6b7180' }}>
              {t('globalError.reference')}{' '}
              <code style={{ fontFamily: 'ui-monospace, monospace' }}>digest {error.digest}</code>
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            style={{
              cursor: 'pointer',
              border: 0,
              borderRadius: '8px',
              height: '34px',
              padding: '0 14px',
              fontSize: '13.5px',
              fontWeight: 600,
              background: '#2e44d6',
              color: '#ffffff',
            }}
          >
            {tc('retry')}
          </button>
        </main>
      </body>
    </html>
  );
}
