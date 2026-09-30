import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { eq, getAppSettingsValue, getDb, lastSignIn, users } from '@pupitre/db';
import { PageHeader } from '@/components/page-header';
import { Crumb } from '@/components/shell/breadcrumb';
import { account as messages } from '@/i18n/messages/account';
import { common } from '@/i18n/messages/common';
import { getT } from '@/i18n/server';
import { listAccountSessions } from '@/lib/account-sessions';
import { formatDateTime, formatSettingsOf } from '@/lib/format';
import { compactIp } from '@/lib/ip';
import { requirePageSession } from '@/lib/page-auth';
import { relativeTime } from '@/lib/relative-time';
import { PasswordForm } from './password-form';
import { SessionsCard } from './sessions-card';
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
  const tc = await getT(common);

  const [[row], { sessions }, signIn, settings] = await Promise.all([
    getDb()
      .select({ twoFactorEnabled: users.twoFactorEnabled })
      .from(users)
      .where(eq(users.id, auth.userId)),
    listAccountSessions(await headers()),
    lastSignIn(auth.userId),
    getAppSettingsValue(),
  ]);

  // « 30/09/2026 08:30 · TOTP · 192.168.10.12 » : quand, comment, d'où.
  const lastSignInLabel = signIn
    ? [
        formatDateTime(signIn.at, formatSettingsOf(settings)),
        t(`sessions.method.${signIn.method}`),
        compactIp(signIn.ip),
      ]
        .filter(Boolean)
        .join(' · ')
    : null;

  return (
    <>
      <Crumb label={t('crumb')} />
      <PageHeader
        title={t('page.title')}
        description={t('page.description')}
        actions={<span className="mono t-cap text-text-3">{auth.email}</span>}
      />

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <PasswordForm />
        <TwoFactorPanel enabled={row?.twoFactorEnabled ?? false} />
      </div>

      <SessionsCard
        sessions={sessions.map((session) => ({
          id: session.id,
          current: session.current,
          device: session.device,
          ipAddress: session.ipAddress,
          lastActive: relativeTime(session.updatedAt, tc),
        }))}
        lastSignIn={lastSignInLabel}
      />
    </>
  );
}
