import type { ReactNode } from 'react';

/**
 * The frame of the public status pages: no rail, no bar, no session — a column
 * centered on the application's background, in its theme.
 */
export default function StatusLayout({ children }: { children: ReactNode }) {
  return <main className="min-h-dvh bg-bg px-4 py-10 sm:py-16">{children}</main>;
}
