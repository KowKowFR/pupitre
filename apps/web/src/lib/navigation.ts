import type { Permission } from '@pupitre/core';

/**
 * Les sections du panel — une seule source pour le rail, la palette ⌘K et les
 * raccourcis `G` puis une lettre.
 *
 * Chaque entrée porte **la permission que sa page exige** : ce qu'un rôle ne
 * peut pas ouvrir disparaît du rail, de la palette et des raccourcis d'un même
 * geste. Rien n'est grisé pour une raison de droits.
 *
 * Module pur, sans React : il sert à la coquille (serveur), à la palette
 * (client) et aux tests.
 */

export type SectionKey =
  | 'dashboard'
  | 'targets'
  | 'applications'
  | 'catalog'
  | 'servers'
  | 'deployments'
  | 'monitoring'
  | 'jobs'
  | 'logs'
  | 'users'
  | 'roles'
  | 'settings';

export type NavSection = {
  key: SectionKey;
  href: string;
  /** `null` : toute session peut ouvrir la page. */
  permission: Permission | null;
  /** Lettre du raccourci `G` puis… */
  shortcut?: string;
};

export type NavGroup = { key: 'operations' | 'administration'; sections: NavSection[] };

const NAVIGATION: readonly NavGroup[] = [
  {
    key: 'operations',
    sections: [
      { key: 'dashboard', href: '/', permission: null, shortcut: 'D' },
      { key: 'targets', href: '/targets', permission: 'target:read', shortcut: 'C' },
      { key: 'applications', href: '/applications', permission: 'application:read', shortcut: 'A' },
      // Le catalogue ne sert qu'à créer : sans ce droit, il n'y a rien à y faire.
      { key: 'catalog', href: '/catalog', permission: 'application:create' },
      { key: 'servers', href: '/apps', permission: 'deployment:read' },
      { key: 'deployments', href: '/deployments', permission: 'deployment:read', shortcut: 'P' },
      { key: 'monitoring', href: '/monitors', permission: 'monitor:read', shortcut: 'S' },
      { key: 'jobs', href: '/jobs', permission: 'job:read' },
    ],
  },
  {
    key: 'administration',
    sections: [
      { key: 'logs', href: '/admin/logs', permission: 'audit:read' },
      { key: 'users', href: '/admin/users', permission: 'user:manage' },
      { key: 'roles', href: '/admin/roles', permission: 'role:read' },
      { key: 'settings', href: '/admin/settings', permission: 'settings:read' },
    ],
  },
];

/** Les groupes visibles pour une session ; un groupe vide disparaît. */
export function visibleNavigation(can: (permission: Permission) => boolean): NavGroup[] {
  return NAVIGATION.map((group) => ({
    key: group.key,
    sections: group.sections.filter(
      (section) => section.permission === null || can(section.permission),
    ),
  })).filter((group) => group.sections.length > 0);
}

/** La section active pour un chemin : `/` n'est actif que sur lui-même. */
export function activeSection(
  pathname: string,
  groups: readonly NavGroup[] = NAVIGATION,
): SectionKey | null {
  let best: NavSection | null = null;
  for (const section of groups.flatMap((group) => group.sections)) {
    const hit =
      section.href === '/'
        ? pathname === '/'
        : pathname === section.href || pathname.startsWith(`${section.href}/`);
    if (hit && (best === null || section.href.length > best.href.length)) best = section;
  }
  return best?.key ?? null;
}

/**
 * Les commandes de la palette et ce qu'elles exigent. Une commande interdite
 * n'apparaît pas — elle n'est ni grisée ni expliquée.
 */
export type CommandKey =
  'deploy' | 'testTargets' | 'newApp' | 'newTarget' | 'theme' | 'language' | 'shortcuts';

const COMMANDS: ReadonlyArray<{
  key: CommandKey;
  permission: Permission | null;
  group: 'suggestions' | 'preferences';
}> = [
  { key: 'deploy', permission: 'deployment:create', group: 'suggestions' },
  { key: 'testTargets', permission: 'target:update', group: 'suggestions' },
  { key: 'newApp', permission: 'application:create', group: 'suggestions' },
  { key: 'newTarget', permission: 'target:create', group: 'suggestions' },
  { key: 'theme', permission: null, group: 'preferences' },
  { key: 'language', permission: 'settings:manage', group: 'preferences' },
  { key: 'shortcuts', permission: null, group: 'preferences' },
];

export function visibleCommands(can: (permission: Permission) => boolean): CommandKey[] {
  return COMMANDS.filter((command) => command.permission === null || can(command.permission)).map(
    (command) => command.key,
  );
}

/**
 * Une saisie de palette : le préfixe `›` (ou `>`) ne garde que les commandes.
 */
export function parsePaletteQuery(raw: string): { query: string; commandsOnly: boolean } {
  const trimmed = raw.trimStart();
  const commandsOnly = trimmed.startsWith('›') || trimmed.startsWith('>');
  return { query: (commandsOnly ? trimmed.slice(1) : trimmed).trim(), commandsOnly };
}
