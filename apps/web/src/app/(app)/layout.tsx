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
import { currentAuth, redirectToLogin } from '@/lib/page-auth';
import { parseTheme, THEME_COOKIE } from '@/lib/theme';
import { workerStatus } from '@/lib/worker-status';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  // Pas de session valide : direction la connexion (par `/logout` si un cookie périmé traîne).
  const auth = (await currentAuth()) ?? (await redirectToLogin());

  const { settings } = await getAppSettings();

  /**
   * L'assistant de démarrage se décide ici, et nulle part ailleurs : c'est le
   * seul endroit du parcours authentifié qui dispose à la fois de la session et
   * des paramètres d'instance. `proxy.ts` ne verrait qu'un cookie.
   *
   * La redirection ne peut pas boucler : `/onboarding` vit dans son propre
   * groupe de routes, ce layout ne l'enveloppe pas. C'est aussi ce qui lui
   * donne une coquille sans rail de navigation.
   */
  const gate = onboardingGate(auth, settings);
  if (gate.shouldOffer) {
    // On enregistre le fait que l'assistant a été montré, mais la redirection
    // ne dépend pas de cette écriture : une instance sans cible doit y être
    // renvoyée même quand l'état n'a plus rien à changer.
    await offerOnboarding(auth);
    redirect('/onboarding');
  }

  const t = await getT(chrome);
  const tOnboarding = await getT(onboarding);
  const groups = visibleNavigation(auth.can);
  const sections = groups.flatMap((group) =>
    group.sections.map((section) => ({
      key: section.key,
      href: section.href,
      shortcut: section.shortcut,
    })),
  );

  // Les métas du rail lisent ce que lit la vue d'ensemble, avec les mêmes
  // chargeurs mis en cache : sur `/`, rien n'est lu deux fois.
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
    listChatMembers(),
    countUnreadChat(auth.userId, CHAT_DEFAULT_CHANNEL),
    countUnreadChatMentions(auth.userId, CHAT_DEFAULT_CHANNEL),
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
    roleLabel,
    theme: parseTheme(cookieStore.get(THEME_COOKIE)?.value),
  };

  return (
    <TooltipProvider>
      <RealtimeProvider
        me={auth.userId}
        members={chatMembers.map((member) => ({ id: member.id, name: member.name }))}
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
                <Topbar instanceName={settings.instanceName} sections={sections} worker={worker} />
                <main id="contenu" className="page">
                  {children}
                </main>
              </div>
            </div>
            <ChatDock canModerate={auth.can('user:manage')} format={formatSettingsOf(settings)} />
            <Toaster />
          </CrumbProvider>
        </ShellProvider>
      </RealtimeProvider>
    </TooltipProvider>
  );
}
