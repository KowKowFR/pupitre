import type { ReactNode } from 'react';
import { currentAuth, redirectToLogin } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

/**
 * Coquille de l'activation exigée du second facteur — nue, comme celle de
 * l'assistant de démarrage, et pour la même raison de fond : hors du groupe
 * `(app)`, la redirection qu'y pose son layout ne peut pas boucler.
 */
export default async function TwoFactorLayout({ children }: { children: ReactNode }) {
  if (!(await currentAuth())) await redirectToLogin();

  return <div className="min-h-dvh bg-bg">{children}</div>;
}
