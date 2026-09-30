'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useT } from '@/i18n/client';
import { auth as messages } from '@/i18n/messages/auth';
import { signOut } from '@/lib/auth-client';

export function LogoutRunner() {
  const t = useT(messages);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    void signOut().finally(() => {
      if (cancelled) return;
      router.replace('/login');
      router.refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <p className="flex items-center gap-2.5 text-sm text-text-2">
      <span
        aria-hidden
        className="inline-block size-4 animate-spin rounded-full border-2 border-accent border-t-transparent"
      />
      {t('logout.pending')}
    </p>
  );
}
