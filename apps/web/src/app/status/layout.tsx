import type { ReactNode } from 'react';

/**
 * Le cadre des pages de statut publiques : ni rail, ni barre, ni session —
 * une colonne centrée sur le fond de l'application, dans son thème.
 */
export default function StatusLayout({ children }: { children: ReactNode }) {
  return <main className="min-h-dvh bg-bg px-4 py-10 sm:py-16">{children}</main>;
}
