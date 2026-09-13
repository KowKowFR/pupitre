import Link from 'next/link';
import {
  Activity,
  Boxes,
  Gauge,
  KeyRound,
  LogOut,
  Radar,
  Rocket,
  ScrollText,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Timer,
  Users,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { RoleKey } from '@pupitre/core';
import { Badge } from '@/components/ui/badge';
import { NavLink } from '@/components/nav-link';
import { getT } from '@/i18n/server';
import { chrome } from '@/i18n/messages/chrome';

type Props = {
  email: string;
  name: string;
  roles: RoleKey[];
  canManageUsers: boolean;
  canManageRoles: boolean;
  canReadAudit: boolean;
  canReadJobs: boolean;
  canReadMonitors: boolean;
  canManageSettings: boolean;
  /** Identité de l'instance, issue des paramètres. Plus rien n'est en dur ici. */
  instanceName: string;
  instanceTagline: string;
};

type NavItem = { href: string; label: string; icon: ReactNode; visible: boolean };

/**
 * Rail de navigation.
 *
 * Deux groupes, pas une liste plate : « Exploitation » regroupe ce qu'on
 * manipule au quotidien, « Administration » ce qui touche aux droits et aux
 * traces. La coupure n'est pas décorative — c'est la même que celle des
 * permissions, et un groupe vide ne s'affiche pas.
 *
 * Au-dessus de `lg` le rail est fixe à gauche ; en dessous il redevient une
 * barre haute dont la nav défile horizontalement. Une seule source pour les
 * entrées dans les deux cas.
 */
export async function AppHeader({
  email,
  name,
  roles,
  canManageUsers,
  canManageRoles,
  canReadAudit,
  canReadJobs,
  canReadMonitors,
  canManageSettings,
  instanceName,
  instanceTagline,
}: Props) {
  const t = await getT(chrome);

  const operations: NavItem[] = [
    { href: '/', label: t('nav.dashboard'), icon: <Gauge />, visible: true },
    { href: '/targets', label: t('nav.targets'), icon: <Server />, visible: true },
    { href: '/applications', label: t('nav.applications'), icon: <Boxes />, visible: true },
    { href: '/apps', label: t('nav.servers'), icon: <Activity />, visible: true },
    { href: '/monitors', label: t('nav.monitoring'), icon: <Radar />, visible: canReadMonitors },
    { href: '/deployments', label: t('nav.deployments'), icon: <Rocket />, visible: true },
    { href: '/jobs', label: t('nav.jobs'), icon: <Timer />, visible: canReadJobs },
  ];

  const administration: NavItem[] = [
    { href: '/admin/logs', label: t('nav.logs'), icon: <ScrollText />, visible: canReadAudit },
    { href: '/admin/users', label: t('nav.users'), icon: <Users />, visible: canManageUsers },
    { href: '/admin/roles', label: t('nav.roles'), icon: <KeyRound />, visible: canManageRoles },
    {
      href: '/admin/settings',
      label: t('nav.settings'),
      icon: <SlidersHorizontal />,
      visible: canManageSettings,
    },
  ];

  const groups = [
    {
      key: 'ops',
      label: t('nav.group.operations'),
      items: operations.filter((item) => item.visible),
    },
    {
      key: 'admin',
      label: t('nav.group.administration'),
      items: administration.filter((item) => item.visible),
    },
  ].filter((group) => group.items.length > 0);

  const flat = groups.flatMap((group) => group.items);

  return (
    <>
      {/* Rail — écrans larges */}
      <aside className="sticky top-0 hidden h-dvh flex-col gap-6 overflow-y-auto border-r border-line bg-ground-deep px-3 py-5 lg:flex">
        <Wordmark name={instanceName} tagline={instanceTagline} />

        <nav className="flex flex-1 flex-col gap-5" aria-label={t('nav.landmark')}>
          {groups.map((group) => (
            <div key={group.key} className="flex flex-col gap-1">
              <span className="eyebrow px-3 pb-1 text-ink-faint">{group.label}</span>
              {group.items.map((item) => (
                <NavLink key={item.href} href={item.href} icon={item.icon}>
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <Operator
          email={email}
          name={name}
          roles={roles}
          accountLabel={t('nav.account')}
          signOutLabel={t('nav.signOut')}
        />
      </aside>

      {/* Barre haute — écrans étroits */}
      <header className="sticky top-0 z-20 border-b border-line bg-ground/85 backdrop-blur-md lg:hidden">
        <div className="flex items-center gap-4 px-4 py-3">
          <Wordmark name={instanceName} tagline={instanceTagline} compact />
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden font-mono text-xs text-ink-muted sm:inline">{email}</span>
            <Link
              href="/account"
              aria-label={t('nav.account')}
              className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <ShieldCheck className="size-4" />
            </Link>
            <Link
              href="/logout"
              aria-label={t('nav.signOut')}
              className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <LogOut className="size-4" />
            </Link>
          </div>
        </div>
        <nav
          aria-label={t('nav.landmark')}
          className="flex gap-1 overflow-x-auto px-3 pb-2 [scrollbar-width:none]"
        >
          {flat.map((item) => (
            <NavLink key={item.href} href={item.href} icon={item.icon}>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>
    </>
  );
}

/**
 * Marque. Le carré de signal reprend la couleur d'accent : c'est le seul
 * aplat coloré permanent de l'interface, et il sert de repère de retour
 * au tableau de bord.
 */
function Wordmark({
  name,
  tagline,
  compact = false,
}: {
  name: string;
  tagline: string;
  compact?: boolean;
}) {
  return (
    <Link
      href="/"
      className="flex shrink-0 items-center gap-2.5 rounded-md px-1 py-1 transition-opacity hover:opacity-80"
    >
      <span
        aria-hidden
        className="flex size-7 shrink-0 items-center justify-center rounded-[5px] bg-signal shadow-panel"
      >
        <span className="size-2 rounded-[1px] bg-signal-ink" />
      </span>
      <span className="flex flex-col leading-none">
        <span className="font-condensed text-[0.9375rem] font-semibold tracking-[0.01em] text-ink">
          {name}
        </span>
        {compact || tagline === '' ? null : (
          <span className="eyebrow pt-1 text-ink-faint">{tagline}</span>
        )}
      </span>
    </Link>
  );
}

/** Bloc opérateur en pied de rail : qui est connecté, avec quels rôles. */
function Operator({
  email,
  name,
  roles,
  accountLabel,
  signOutLabel,
}: {
  email: string;
  name: string;
  roles: RoleKey[];
  accountLabel: string;
  signOutLabel: string;
}) {
  return (
    <div className="flex shrink-0 flex-col gap-2 rounded-lg border border-line bg-surface p-3 shadow-panel">
      <div className="min-w-0">
        <div className="truncate text-[0.8125rem] font-medium text-ink">{name}</div>
        <div className="truncate font-mono text-[0.6875rem] text-ink-faint">{email}</div>
      </div>
      {roles.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {roles.map((role) => (
            <Badge key={role} variant="secondary">
              {role}
            </Badge>
          ))}
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        {/* Le compte n'est pas une section d'exploitation : il vit près de
            l'identité de l'opérateur, pas dans la navigation métier. */}
        <Link
          href="/account"
          className="flex items-center gap-1.5 text-xs text-ink-muted transition-colors hover:text-ink"
        >
          <ShieldCheck className="size-3.5" />
          {accountLabel}
        </Link>
        <Link
          href="/logout"
          className="flex items-center gap-1.5 text-xs text-ink-muted transition-colors hover:text-ink"
        >
          <LogOut className="size-3.5" />
          {signOutLabel}
        </Link>
      </div>
    </div>
  );
}
