import type { ReactNode } from 'react';
import { getT } from '@/i18n/server';
import { auth as messages } from '@/i18n/messages/auth';
import { AccessShell } from '@/components/access-shell';

/**
 * The entrance screen. A very faint grid background — a rack plan rather than a
 * gradient —, the brand above the panel, the instance mention below. The grid is
 * purely decorative and hidden from assistive technologies.
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
