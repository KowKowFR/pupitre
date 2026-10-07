import type { Permission } from '@pupitre/core';

/**
 * The panel's sections — a single source for the rail, the ⌘K palette and the
 * `G` then a letter shortcuts.
 *
 * Each entry carries **the permission its page requires**: what a role cannot
 * open disappears from the rail, the palette and the shortcuts in one gesture.
 * Nothing is greyed out for a reason of rights.
 *
 * A pure module, without React: it serves the shell (server), the palette
 * (client) and the tests.
 */

export type SectionKey =
  | 'dashboard'
  | 'targets'
  | 'applications'
  | 'catalog'
  | 'servers'
  | 'deployments'
  | 'domains'
  | 'monitoring'
  | 'maintenance'
  | 'jobs'
  | 'statusPages'
  | 'logs'
  | 'users'
  | 'roles'
  | 'settings'
  | 'docs';

export type NavSection = {
  key: SectionKey;
  href: string;
  /**
   * `null`: any session can open the page. A list: one of them is enough — the page
   * shows each one the part that is theirs.
   */
  permission: Permission | readonly Permission[] | null;
  /** Letter of the `G` then… shortcut. */
  shortcut?: string;
};

export type NavGroup = { key: 'operations' | 'administration' | 'help'; sections: NavSection[] };

const NAVIGATION: readonly NavGroup[] = [
  {
    key: 'operations',
    sections: [
      { key: 'dashboard', href: '/', permission: null, shortcut: 'D' },
      { key: 'targets', href: '/targets', permission: 'target:read', shortcut: 'C' },
      { key: 'applications', href: '/applications', permission: 'application:read', shortcut: 'A' },
      // The catalog only serves to create: without that right, there is nothing to do
      // there.
      { key: 'catalog', href: '/catalog', permission: 'application:create' },
      { key: 'servers', href: '/apps', permission: 'deployment:read' },
      { key: 'deployments', href: '/deployments', permission: 'deployment:read', shortcut: 'P' },
      // All the instance's domains: what can be seen of a domain reads with the
      // permission that already gives its domains on an application's record.
      { key: 'domains', href: '/domains', permission: 'application:read' },
      { key: 'monitoring', href: '/monitors', permission: 'monitor:read', shortcut: 'S' },
      { key: 'maintenance', href: '/maintenance', permission: 'maintenance:read' },
      { key: 'jobs', href: '/jobs', permission: 'job:read' },
    ],
  },
  {
    key: 'administration',
    sections: [
      { key: 'logs', href: '/admin/logs', permission: 'audit:read' },
      { key: 'users', href: '/admin/users', permission: 'user:manage' },
      { key: 'roles', href: '/admin/roles', permission: 'role:read' },
      // What strangers will see: an administration decision. Composing the pages, or
      // announcing an outage there: either one opens the screen.
      {
        key: 'statusPages',
        href: '/status-pages',
        permission: ['status_page:manage', 'status_page:announce'],
      },
      { key: 'settings', href: '/admin/settings', permission: 'settings:read' },
    ],
  },
  {
    key: 'help',
    // How the panel works, from A to Z: every session reads it — the sections it
    // describes stay guarded by their own permission.
    sections: [{ key: 'docs', href: '/docs', permission: null, shortcut: 'H' }],
  },
];

function allowed(
  permission: NavSection['permission'],
  can: (permission: Permission) => boolean,
): boolean {
  if (permission === null) return true;
  return typeof permission === 'string' ? can(permission) : permission.some(can);
}

/** The groups visible to a session; an empty group disappears. */
export function visibleNavigation(can: (permission: Permission) => boolean): NavGroup[] {
  return NAVIGATION.map((group) => ({
    key: group.key,
    sections: group.sections.filter((section) => allowed(section.permission, can)),
  })).filter((group) => group.sections.length > 0);
}

/** The active section for a path: `/` is only active on itself. */
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
 * The palette's commands and what they require. A forbidden command does not
 * appear — it is neither greyed out nor explained.
 */
export type CommandKey =
  | 'deploy'
  | 'testTargets'
  | 'newApp'
  | 'newTarget'
  | 'theme'
  | 'language'
  | 'shortcuts'
  // The actions on a found object: "test prod-1", "restart umami"…
  | 'act.test'
  | 'act.editTarget'
  | 'act.deploy'
  | 'act.restart'
  | 'act.probe'
  | 'act.pause'
  | 'act.editMonitor'
  // The settings' tabs, and the search continued in a screen.
  | 'settings'
  | 'searchLogs'
  | 'searchRuns';

const COMMANDS: ReadonlyArray<{
  key: CommandKey;
  permission: Permission | null;
  group: 'suggestions' | 'preferences' | 'actions' | 'goto';
}> = [
  { key: 'deploy', permission: 'deployment:create', group: 'suggestions' },
  { key: 'testTargets', permission: 'target:update', group: 'suggestions' },
  { key: 'newApp', permission: 'application:create', group: 'suggestions' },
  { key: 'newTarget', permission: 'target:create', group: 'suggestions' },
  { key: 'theme', permission: null, group: 'preferences' },
  { key: 'language', permission: 'settings:manage', group: 'preferences' },
  { key: 'shortcuts', permission: null, group: 'preferences' },
  { key: 'act.test', permission: 'target:update', group: 'actions' },
  { key: 'act.editTarget', permission: 'target:update', group: 'actions' },
  { key: 'act.deploy', permission: 'deployment:create', group: 'actions' },
  { key: 'act.restart', permission: 'deployment:restart', group: 'actions' },
  { key: 'act.probe', permission: 'monitor:manage', group: 'actions' },
  { key: 'act.pause', permission: 'monitor:manage', group: 'actions' },
  { key: 'act.editMonitor', permission: 'monitor:manage', group: 'actions' },
  { key: 'settings', permission: 'settings:read', group: 'goto' },
  { key: 'searchLogs', permission: 'audit:read', group: 'goto' },
  { key: 'searchRuns', permission: 'deployment:read', group: 'goto' },
];

export function visibleCommands(can: (permission: Permission) => boolean): CommandKey[] {
  return COMMANDS.filter((command) => command.permission === null || can(command.permission)).map(
    (command) => command.key,
  );
}

/**
 * A palette input: the `›` (or `>`) prefix only keeps the commands.
 */
export function parsePaletteQuery(raw: string): { query: string; commandsOnly: boolean } {
  const trimmed = raw.trimStart();
  const commandsOnly = trimmed.startsWith('›') || trimmed.startsWith('>');
  return { query: (commandsOnly ? trimmed.slice(1) : trimmed).trim(), commandsOnly };
}

/** An action verb typed in the palette, and the families of objects it applies to. */
export type PaletteVerb =
  'test' | 'edit' | 'deploy' | 'restart' | 'logs' | 'probe' | 'pause' | 'resume' | 'versions';

export const PALETTE_VERBS: Record<
  PaletteVerb,
  {
    words: readonly string[];
    kinds: ReadonlyArray<'target' | 'application' | 'running' | 'monitor'>;
  }
> = {
  test: { words: ['tester', 'teste', 'test', 'preflight'], kinds: ['target'] },
  edit: { words: ['modifier', 'modifie', 'editer', 'edit'], kinds: ['target', 'monitor'] },
  deploy: { words: ['deployer', 'deploie', 'deploy'], kinds: ['application'] },
  restart: { words: ['redemarrer', 'redemarre', 'restart', 'relancer'], kinds: ['running'] },
  logs: { words: ['logs', 'log', 'console'], kinds: ['running'] },
  probe: { words: ['sonder', 'probe', 'verifier'], kinds: ['monitor'] },
  pause: { words: ['suspendre', 'pause', 'pauser'], kinds: ['monitor'] },
  resume: { words: ['reprendre', 'resume', 'reactiver'], kinds: ['monitor'] },
  versions: { words: ['versions', 'historique'], kinds: ['application'] },
};

function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Separates from an input the action verbs and what names the object:
 * "redémarrer umami" → `{ verbs: ['restart'], rest: 'umami' }`. Accents and case
 * do not count; a word that is not a verb stays with the name.
 */
export function splitPaletteVerbs(query: string): { verbs: PaletteVerb[]; rest: string } {
  const verbs: PaletteVerb[] = [];
  const rest: string[] = [];
  for (const token of query.split(/\s+/).filter(Boolean)) {
    const folded = fold(token);
    const verb = (Object.keys(PALETTE_VERBS) as PaletteVerb[]).find((key) =>
      PALETTE_VERBS[key].words.includes(folded),
    );
    if (verb && !verbs.includes(verb)) verbs.push(verb);
    else if (!verb) rest.push(token);
  }
  return { verbs, rest: rest.join(' ') };
}
