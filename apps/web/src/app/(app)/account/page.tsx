import type { Metadata } from 'next';
import { eq, getDb, users } from '@pupitre/db';
import { PageHeader } from '@/components/page-header';
import { account as messages } from '@/i18n/messages/account';
import { getT } from '@/i18n/server';
import { requirePageSession } from '@/lib/page-auth';
import { PasswordForm } from './password-form';
import { TwoFactorPanel } from './two-factor-panel';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT(messages))('meta.title') };
}

export const dynamic = 'force-dynamic';

/**
 * Écran « mon compte ». Aucune permission RBAC : changer son mot de passe et
 * gérer son second facteur sont des actions sur soi, pas des privilèges. Une
 * session suffit — et c'est exactement ce que vérifient les routes derrière.
 */
export default async function AccountPage() {
  const auth = await requirePageSession('/account');
  const t = await getT(messages);

  const [row] = await getDb()
    .select({ twoFactorEnabled: users.twoFactorEnabled })
    .from(users)
    .where(eq(users.id, auth.userId));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={t('page.eyebrow')}
        title={t('page.title')}
        description={t('page.description')}
        actions={<span className="font-mono text-xs text-text-3">{auth.email}</span>}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <PasswordForm />
        <TwoFactorPanel enabled={row?.twoFactorEnabled ?? false} />
      </div>
    </div>
  );
}
