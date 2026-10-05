import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { CHAT_DEFAULT_CHANNEL } from '@pupitre/core';
import {
  countUnreadChat,
  countUnreadChatMentions,
  getAppSettings,
  listChatMembers,
  listRoles,
} from '@pupitre/db';
import { ChatDock } from '@/components/chat/chat-dock';
import { LiveRefresh } from '@/components/realtime/live-refresh';
import { RealtimeProvider } from '@/components/realtime/realtime-provider';
import { CrumbProvider } from '@/components/shell/breadcrumb';
import type { NavMeta } from '@/components/shell/nav-item';
import { Rail } from '@/components/shell/rail';
import { ShellProvider } from '@/components/shell/shell-provider';
import { MobileHeader, Topbar } from '@/components/shell/topbar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/toaster';
import { getT } from '@/i18n/server';
import { chrome } from '@/i18n/messages/chrome';
import { onboarding } from '@/i18n/messages/onboarding';
import { formatSettingsOf } from '@/lib/format';
import { visibleCommands, visibleNavigation } from '@/lib/navigation';
import { offerOnboarding, onboardingGate } from '@/lib/onboarding-gate';
import {
  attentionFor,
  loadApplications,
  loadMonitors,
  loadRecentDeployments,
  loadTargets,
} from '@/lib/overview';
import { currentAuth, redirectToLogin, TWO_FACTOR_ENROLL_PATH } from '@/lib/page-auth';
import { isTeamMember } from '@/lib/rbac';
import { parseTheme, THEME_COOKIE } from '@/lib/theme';
import { workerStatus } from '@/lib/worker-status';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  // No valid session: off to sign-in (through `/logout` if a stale cookie lingers).
  const auth = (await currentAuth()) ?? (await redirectToLogin());

  /**
   * A role that requires the second factor, an account that does not have it: it
   * only sees the screen that enables it. The API refuses it anyway
   * (`requirePermission`) — this is only its visible face.
   */
  if (auth.twoFactor.mustEnroll) redirect(TWO_FACTOR_ENROLL_PATH);

  const { settings } = await getAppSettings();

  /**
   * The onboarding assistant is decided here, and nowhere else: it is the only
   * place of the authenticated journey that has both the session and the instance
   * settings. `proxy.ts` would only see a cookie.
   *
   * The redirect cannot loop: `/onboarding` lives in its own route group, this
   * layout does not wrap it. That is also what gives it a shell without a
   * navigation rail.
   */
  const gate = onboardingGate(auth, settings);
  if (gate.shouldOffer) {
    // We record the fact that the assistant was shown, but the redirect does not
    // depend on that write: an instance without a target must be sent back there
    // even when the state has nothing left to change.
    await offerOnboarding(auth);
    redirect('/onboarding');
  }

  const t = await getT(chrome);
  const tOnboarding = await getT(onboarding);
  // An account without any permission is not part of the team yet: no chat, no
  // presence (`isTeamMember`).
  const member = isTeamMember(auth);
  const groups = visibleNavigation(auth.can);
  const sections = groups.flatMap((group) =>
    group.sections.map((section) => ({
      key: section.key,
      href: section.href,
      shortcut: section.shortcut,
    })),
  );

  // The rail's metas read what the overview reads, with the same cached loaders:
  // on `/`, nothing is read twice.
  const [
    attention,
    targets,
    applications,
    recent,
    monitors,
    worker,
    roles,
    cookieStore,
    chatMembers,
    chatUnread,
    chatMentions,
  ] = await Promise.all([
    attentionFor(auth),
    auth.can('target:read') ? loadTargets() : Promise.resolve(null),
    auth.can('application:read') ? loadApplications() : Promise.resolve(null),
    auth.can('deployment:read') ? loadRecentDeployments() : Promise.resolve(null),
    auth.can('monitor:read') ? loadMonitors() : Promise.resolve(null),
    workerStatus(),
    listRoles(),
    cookies(),
    member ? listChatMembers() : Promise.resolve([]),
    member ? countUnreadChat(auth.userId, CHAT_DEFAULT_CHANNEL) : Promise.resolve(0),
    member ? countUnreadChatMentions(auth.userId, CHAT_DEFAULT_CHANNEL) : Promise.resolve(0),
  ]);

  const metas: Partial<Record<string, NavMeta>> = {};
  if (attention.length > 0) {
    metas.dashboard = {
      kind: 'count',
      value: attention.length,
      alert: true,
      label: t('shell.meta.alerts', { count: attention.length }),
    };
  }
  if (targets) metas.targets = { kind: 'count', value: targets.length };
  if (applications) metas.applications = { kind: 'count', value: applications.length };
  if (recent?.items.some((item) => item.status === 'running' || item.status === 'pending')) {
    metas.deployments = { kind: 'inflight', label: t('shell.meta.inflight') };
  }
  const failing = monitors?.filter(
    (monitor) =>
      monitor.enabled && (monitor.status === 'unhealthy' || monitor.status === 'unreachable'),
  ).length;
  if (failing) metas.monitoring = { kind: 'count', value: failing, alert: true };

  const actionable = gate.steps.filter((step) => step.requires !== null);
  const done = actionable.filter((step) => gate.state.completed.includes(step.id)).length;
  const railOnboarding = gate.resumable
    ? { done, total: actionable.length, next: tOnboarding(`step.${gate.state.currentStep}.title`) }
    : null;

  const roleLabel =
    auth.roles.map((key) => roles.find((role) => role.key === key)?.label ?? key).join(', ') || '—';
  const user = {
    name: auth.name,
    email: auth.email,
    image: auth.image,
    roleLabel,
    theme: parseTheme(cookieStore.get(THEME_COOKIE)?.value),
  };

  return (
    <TooltipProvider>
      <RealtimeProvider
        me={auth.userId}
        members={chatMembers.map((member) => ({
          id: member.id,
          name: member.name,
          image: member.image,
        }))}
        initialUnread={chatUnread}
        initialMentions={chatMentions}
      >
        <ShellProvider sections={sections} commands={visibleCommands(auth.can)}>
          <CrumbProvider>
            <div className="shell">
              <Rail
                instance={{ name: settings.instanceName, tagline: settings.instanceTagline }}
                groups={groups}
                metas={metas}
                onboarding={railOnboarding}
                user={user}
                canOpenSettings={auth.can('settings:read')}
              />
              <div className="main">
                <MobileHeader
                  instanceName={settings.instanceName}
                  sections={sections.map((section) => ({
                    ...section,
                    label: t(`nav.${section.key}`),
                  }))}
                  metas={metas}
                  user={user}
                />
                <Topbar
                  instanceName={settings.instanceName}
                  sections={sections}
                  worker={worker}
                  team={member}
                />
                <main id="contenu" className="page">
                  {children}
                </main>
              </div>
            </div>
            {member ? (
              <ChatDock canModerate={auth.can('user:manage')} format={formatSettingsOf(settings)} />
            ) : null}
            {/* A changed profile picture, a renamed account: the face and the name
                update in the rail, the presence and the chat. */}
            <LiveRefresh topics={['users']} />
            <Toaster />
          </CrumbProvider>
        </ShellProvider>
      </RealtimeProvider>
    </TooltipProvider>
  );
}
