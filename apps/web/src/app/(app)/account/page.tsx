import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { eq, getAppSettingsValue, getDb, lastSignIn, listRoles, users } from '@pupitre/db';
import { PageHeader } from '@/components/page-header';
import { Crumb } from '@/components/shell/breadcrumb';
import { account as messages } from '@/i18n/messages/account';
import { common } from '@/i18n/messages/common';
import { getT } from '@/i18n/server';
import { listAccountSessions } from '@/lib/account-sessions';
import { formatDateTime, formatDateTimeWith, formatSettingsOf } from '@/lib/format';
import { compactIp } from '@/lib/ip';
import { requirePageSession } from '@/lib/page-auth';
import { relativeTime } from '@/lib/relative-time';
import { AccountOverview } from './account-overview';
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

  const [[row], { sessions }, signIn, settings, roles] = await Promise.all([
    getDb()
      .select({ twoFactorEnabled: users.twoFactorEnabled, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.id, auth.userId)),
    listAccountSessions(await headers()),
    lastSignIn(auth.userId),
    getAppSettingsValue(),
    listRoles(),
  ]);
  const format = formatSettingsOf(settings);
  const twoFactorEnabled = row?.twoFactorEnabled ?? false;
  const roleLabels = auth.roles.map((key) => roles.find((role) => role.key === key)?.label ?? key);

  return (
    <>
      <Crumb label={t('crumb')} />
      <PageHeader title={t('page.title')} description={t('page.description')} />

      <AccountOverview
        name={auth.name}
        email={auth.email}
        roles={roleLabels}
        since={
          row?.createdAt
            ? t('overview.since', {
                date: formatDateTimeWith(row.createdAt, format, {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                }),
              })
            : null
        }
        twoFactor={{
          enabled: twoFactorEnabled,
          label: t('overview.twoFactor'),
          value: twoFactorEnabled ? t('overview.twoFactor.on') : t('overview.twoFactor.off'),
          hint: twoFactorEnabled
            ? t('overview.twoFactor.on.hint')
            : t('overview.twoFactor.off.hint'),
        }}
        sessions={{
          label: t('overview.sessions'),
          count: sessions.length,
          hint: t('overview.sessions.hint', { count: sessions.length }),
        }}
        lastSignIn={{
          label: t('sessions.lastSignIn'),
          value: signIn ? (relativeTime(signIn.at, tc) ?? tc('none')) : tc('none'),
          // « 30/09/2026 08:30 · TOTP · 192.168.10.12 » : quand, comment, d'où.
          hint: signIn
            ? [
                formatDateTime(signIn.at, format),
                t(`sessions.method.${signIn.method}`),
                compactIp(signIn.ip),
              ]
                .filter(Boolean)
                .join(' · ')
            : t('overview.lastSignIn.none'),
        }}
      />

      {/* Deux cartes de même hauteur : pas de vide sous la plus courte. */}
      <div className="grid grid-cols-1 items-stretch gap-6 lg:grid-cols-2">
        <PasswordForm />
        <TwoFactorPanel enabled={twoFactorEnabled} />
      </div>

      <SessionsCard
        sessions={sessions.map((session) => ({
          id: session.id,
          current: session.current,
          device: session.device,
          ipAddress: session.ipAddress,
          lastActive: relativeTime(session.updatedAt, tc),
        }))}
      />
    </>
  );
}
