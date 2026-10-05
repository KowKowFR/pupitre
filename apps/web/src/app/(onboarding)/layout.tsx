import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { currentAuth, redirectToLogin, TWO_FACTOR_ENROLL_PATH } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

/**
 * The onboarding assistant's shell — deliberately bare.
 *
 * The assistant lives outside the `(app)` group for a fundamental reason: it has
 * no navigation bar. Offering to go to the targets, the applications or the roles
 * while explaining how to declare one's first target is offering twelve ways to
 * get lost in a panel one is discovering. The journey is linear, the screen must
 * be too.
 *
 * It is not only cosmetic. As long as the assistant was nested in `(app)`, it
 * inherited its layout — hence the rail — and the redirect had to deal with a
 * layout that ran again on arrival. Taking it out of the group removes both
 * problems at once.
 *
 * The price: authentication is done again here. It is little, and it is
 * explicit. The header, for its part, is set by the page: its right part depends
 * on the step.
 */
export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  // No valid session: off to sign-in (through `/logout` if a stale cookie lingers).
  const auth = (await currentAuth()) ?? (await redirectToLogin());
  // The required second factor first: as everywhere else (`(app)/layout.tsx`).
  if (auth.twoFactor.mustEnroll) redirect(TWO_FACTOR_ENROLL_PATH);

  return <div className="min-h-dvh bg-bg">{children}</div>;
}
