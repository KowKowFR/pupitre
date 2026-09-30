import type { Metadata } from 'next';
import { eq, getDb, users } from '@pupitre/db';
import { PageHeader } from '@/components/page-header';
import { Crumb } from '@/components/shell/breadcrumb';
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
    <>
      <Crumb label={t('crumb')} />
      <PageHeader
        title={t('page.title')}
        description={t('page.description')}
        actions={<span className="mono t-cap text-text-3">{auth.email}</span>}
      />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <PasswordForm />
        <TwoFactorPanel enabled={row?.twoFactorEnabled ?? false} />
      </div>
    </>
  );
}
