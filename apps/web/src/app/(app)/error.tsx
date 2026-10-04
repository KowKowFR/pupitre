'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { RotateCcw } from 'lucide-react';
import { AccessCard } from '@/components/access-shell';
import { useT } from '@/i18n/client';
import { auth as messages } from '@/i18n/messages/auth';
import { common } from '@/i18n/messages/common';

/**
 * The panel's rendering safety net.
 *
 * Without `error.tsx`, an exception thrown while rendering a page bubbles up to
 * the root: in production Next serves a generic page in English, without
 * navigation. Here the incident stays **inside** the panel — the left rail still
 * answers, and the other screens are one click away.
 *
 * `digest` is shown on purpose. In production the original message is masked by
 * Next so as not to leak internals; the digest is the only link between what the
 * user saw and the corresponding line in the server's logs. Without it, a bug
 * report boils down to "it crashed".
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
    // The browser's console keeps the complete trace, including in development
    // where the message is not masked.
    console.error('[panel] erreur de rendu', error);
  }, [error]);

  return (
    <div className="mx-auto mt-6 w-full max-w-[440px]">
      <AccessCard tone="danger" title={t('appError.title')} description={t('appError.description')}>
        <Alert variant="destructive">
          <span className="mono">{error.message || t('appError.fallback')}</span>
        </Alert>

        {error.digest ? (
          <p className="t-cap text-text-3">
            {t('appError.digest.before')} <code className="mono">digest {error.digest}</code>{' '}
            {t('appError.digest.after')}
          </p>
        ) : null}

        <div className="flex items-center gap-2">
          {/*
            `reset()` renders the segment again without reloading the page:
            it is the right gesture for a passing outage (database unavailable
            for one request) and it costs nothing if the error persists.
                     */}
          <Button onClick={reset}>
            <RotateCcw aria-hidden />
            {tc('retry')}
          </Button>
          <Button asChild variant="ghost">
            <Link href="/">{t('link.back')}</Link>
          </Button>
        </div>
      </AccessCard>
    </div>
  );
}
