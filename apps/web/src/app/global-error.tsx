'use client';

import { useEffect } from 'react';
import { useLanguage, useT } from '@/i18n/client';
import { auth as messages } from '@/i18n/messages/auth';
import { common } from '@/i18n/messages/common';

/**
 * The last safety net: an error thrown by the root layout itself.
 *
 * At this level, neither the layout nor the fonts nor the style sheet are
 * guaranteed — so Next requires rendering `<html>` and `<body>`. The style is
 * written inline for the same reason: if `globals.css` is part of what failed, a
 * utility class would paint nothing. The colors are therefore hard-coded, in the
 * panel's dark tints, rather than inheriting a white browser background in the
 * middle of a dark interface.
 *
 * The language shares the style's fate: it is the root layout that sets the
 * `LanguageProvider`, and it is the one that just failed. `useLanguage()`
 * therefore returns the default language, and `useT()` the source language. It is
 * exactly the fallback `renderMessage()` applies everywhere else — readable French
 * rather than a bare key —, and the document's `lang` says so honestly instead of
 * announcing a language the text does not speak.
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

  // A minimal page with inline styles: at this stage, no style sheet is guaranteed.
  // The colors are the light theme's, hard-coded.
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
