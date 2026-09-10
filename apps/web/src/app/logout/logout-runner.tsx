'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { signOut } from '@/lib/auth-client';

export function LogoutRunner() {
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
    <p className="flex items-center gap-2.5 text-sm text-ink-muted">
      <span
        aria-hidden
        className="inline-block size-4 animate-spin rounded-full border-2 border-signal border-t-transparent"
      />
      Déconnexion…
    </p>
  );
}
