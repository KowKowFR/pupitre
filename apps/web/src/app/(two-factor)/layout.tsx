import type { ReactNode } from 'react';
import { currentAuth, redirectToLogin } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

/**
 * The shell of the required second factor's activation — bare, like the
 * onboarding assistant's, and for the same fundamental reason: outside the
 * `(app)` group, the redirect its layout sets cannot loop.
 */
export default async function TwoFactorLayout({ children }: { children: ReactNode }) {
  if (!(await currentAuth())) await redirectToLogin();

  return <div className="min-h-dvh bg-bg">{children}</div>;
}
