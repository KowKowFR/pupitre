import type { Metadata } from 'next';
import { headers } from 'next/headers';
import {
  eq,
  getAppSettingsValue,
  getDb,
  lastSignIn,
  listApplications,
  listRoles,
  users,
} from '@pupitre/db';
import { PageHeader } from '@/components/page-header';
import { Crumb } from '@/components/shell/breadcrumb';
import { account as messages } from '@/i18n/messages/account';
import { common } from '@/i18n/messages/common';
import { getT } from '@/i18n/server';
import { listAccountSessions } from '@/lib/account-sessions';
import { apiTokenRows, delegablePermissionGroups } from '@/lib/api-token-rows';
import { formatDateTime, formatDateTimeWith, formatSettingsOf } from '@/lib/format';
import { compactIp } from '@/lib/ip';
import { requirePageSession } from '@/lib/page-auth';
import { isTeamMember } from '@/lib/rbac';
import { relativeTime } from '@/lib/relative-time';
import { AccountOverview } from './account-overview';
import { ApiTokensCard } from './api-tokens-card';
import { PasswordForm } from './password-form';
import { SessionsCard } from './sessions-card';
import { TwoFactorPanel } from './two-factor-panel';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT(messages))('meta.title') };
}

export const dynamic = 'force-dynamic';

/** Clock drift tolerated between the panel and the database to place a sign-in. */
const SIGN_IN_SKEW_MS = 5_000;

/**
 * The "my account" screen. No RBAC permission: changing one's password and
 * managing one's second factor are actions on oneself, not privileges. A
 * session is enough — and that is exactly what the routes behind it check.
 */
export default async function AccountPage() {
  const auth = await requirePageSession('/account');
  const t = await getT(messages);
  const tc = await getT(common);

  const [[row], { sessions, previous }, settings, roles] = await Promise.all([
    getDb()
      .select({ twoFactorEnabled: users.twoFactorEnabled, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.id, auth.userId)),
    listAccountSessions(await headers()).then(async ({ sessions }) => {
      // The sign-in that opened this session is written to the log right after it:
      // the previous one is the one before it opened. The margin covers a clock
      // drift between the panel and the database.
      const started = sessions.find((session) => session.current)?.createdAt;
      const before = started ? new Date(Date.parse(started) - SIGN_IN_SKEW_MS) : undefined;
      return { sessions, previous: await lastSignIn(auth.userId, { before }) };
    }),
    getAppSettingsValue(),
    listRoles(),
  ]);
  const format = formatSettingsOf(settings);
  const current = sessions.find((session) => session.current);
  const today = (date: Date | string) => {
    const day = {
      day: 'numeric',
      month: 'numeric',
      year: 'numeric',
      timeZone: format.timezone,
    } as const;
    return formatDateTimeWith(date, format, day) === formatDateTimeWith(new Date(), format, day);
  };
  const twoFactorEnabled = row?.twoFactorEnabled ?? false;
  // A token only delegates permissions: without any, nothing to delegate.
  const tokens = isTeamMember(auth)
    ? await Promise.all([
        apiTokenRows({ userId: auth.userId }, format),
        delegablePermissionGroups(auth.permissions),
        auth.can('application:read') ? listApplications() : Promise.resolve([]),
      ])
    : null;
  const roleLabels = auth.roles.map((key) => roles.find((role) => role.key === key)?.label ?? key);
  const duration = (hours: number) =>
    hours % 24 === 0
      ? t('sessions.days', { count: hours / 24 })
      : t('sessions.hours', { count: hours });
  const { sessionIdleHours, sessionMaxHours } = settings.accounts;

  return (
    <>
      <Crumb label={t('crumb')} />
      <PageHeader title={t('page.title')} description={t('page.description')} />

      <AccountOverview
        name={auth.name}
        email={auth.email}
        image={auth.image}
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
        signIn={{
          label: t('overview.signIn'),
          // "Signed in since 14:32": this session's opening, not a "5 min ago" frozen at
          // the page's rendering.
          value: current
            ? t(today(current.createdAt) ? 'overview.signIn.since' : 'overview.signIn.sinceDay', {
                time: formatDateTimeWith(current.createdAt, format, {
                  hour: '2-digit',
                  minute: '2-digit',
                  timeZone: format.timezone,
                }),
                day: formatDateTimeWith(current.createdAt, format, {
                  day: 'numeric',
                  month: 'short',
                  timeZone: format.timezone,
                }),
              })
            : t('overview.signIn.connected'),
          // "Previous: 30/09/2026 08:30 · TOTP · 192.168.10.12": when, how, from where.
          hint: previous
            ? t('overview.signIn.previous', {
                detail: [
                  formatDateTime(previous.at, format),
                  t(`sessions.method.${previous.method}`),
                  compactIp(previous.ip),
                ]
                  .filter(Boolean)
                  .join(' · '),
              })
            : t('overview.signIn.first'),
        }}
      />

      {/* Two cards of the same height: no gap under the shorter one. */}
      <div className="grid grid-cols-1 items-stretch gap-6 lg:grid-cols-2">
        <PasswordForm />
        <TwoFactorPanel enabled={twoFactorEnabled} required={auth.twoFactor.required} />
      </div>

      <SessionsCard
        description={
          sessionMaxHours === null
            ? t('sessions.description', { idle: duration(sessionIdleHours) })
            : t('sessions.description.max', {
                idle: duration(sessionIdleHours),
                max: duration(sessionMaxHours),
              })
        }
        sessions={sessions.map((session) => ({
          id: session.id,
          current: session.current,
          device: session.device,
          ipAddress: session.ipAddress,
          lastActive: relativeTime(session.updatedAt, tc),
        }))}
      />

      {tokens ? (
        <ApiTokensCard
          rows={tokens[0]}
          groups={tokens[1]}
          applications={tokens[2].map((application) => ({
            id: application.id,
            name: application.name,
          }))}
        />
      ) : null}
    </>
  );
}
