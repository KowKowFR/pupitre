import type { ReactNode } from 'react';
import { getT } from '@/i18n/server';
import { auth as messages } from '@/i18n/messages/auth';
import { AccessShell } from '@/components/access-shell';

/**
 * Écran d'entrée. Fond quadrillé très faible — un plan de baie plutôt qu'un
 * dégradé —, marque au-dessus du panneau, mention d'instance en dessous.
 * Le quadrillage est purement décoratif et masqué aux technologies d'assistance.
 */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const t = await getT(messages);

  return (
    <AccessShell
      tagline={t('shell.tagline')}
      footer={`${t('shell.footer.line1')} ${t('shell.footer.line2')}`}
    >
      {children}
    </AccessShell>
  );
}
