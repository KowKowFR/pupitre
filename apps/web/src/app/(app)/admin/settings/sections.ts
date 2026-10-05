import {
  Bell,
  Building2,
  Compass,
  DatabaseBackup,
  GitBranch,
  Globe,
  LogIn,
  Plug,
  ScanSearch,
  ShieldCheck,
  Signature,
  Sparkles,
  UserLock,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

/**
 * How the settings are divided, in a single place.
 *
 * Ten sections, sorted into four groups: the rail shows the groups, a group's
 * tabs show its sections. Both read this list — a section added to a group
 * appears in its tabs without anyone thinking about it. Each section keeps its
 * address: yesterday's link still works.
 *
 * The sections are **intentions**, not sections of the JSONB. Nobody comes to
 * "edit the `security` key": one comes to turn off the scans, or change the
 * panel's name.
 *
 * ── Why the prose is no longer here ─────────────────────────────────────────
 * The label, the title and the "what the section governs" are displayed text:
 * so they live in the dictionary, under `section.{id}.*`. This catalog only
 * keeps what has no language — the address, the icon, and the `id` that lets
 * each screen compose its key without a mapping table.
 */

/** A section's stable identity. It is what prefixes its text keys. */
export type SettingsSectionId =
  | 'identity'
  | 'regional'
  | 'security'
  | 'sso'
  | 'accounts'
  | 'notifications'
  | 'ai'
  | 'integrations'
  | 'backups'
  | 'onboarding';

export type SettingsSection = {
  /** Absolute path. Also the navigation's activation key (strict equality). */
  href: string;
  /** Prefix of the `section.{id}.label`, `.title` and `.governs` keys. */
  id: SettingsSectionId;
  icon: LucideIcon;
};

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { href: '/admin/settings/identite', id: 'identity', icon: Signature },
  { href: '/admin/settings/regionalisation', id: 'regional', icon: Globe },
  { href: '/admin/settings/securite', id: 'security', icon: ScanSearch },
  { href: '/admin/settings/connexion', id: 'sso', icon: LogIn },
  { href: '/admin/settings/comptes', id: 'accounts', icon: UserLock },
  { href: '/admin/settings/notifications', id: 'notifications', icon: Bell },
  { href: '/admin/settings/ia', id: 'ai', icon: Sparkles },
  { href: '/admin/settings/integrations', id: 'integrations', icon: GitBranch },
  { href: '/admin/settings/sauvegardes', id: 'backups', icon: DatabaseBackup },
  { href: '/admin/settings/demarrage', id: 'onboarding', icon: Compass },
];

/** The settings' root: it leads to the first tab of the first group. */
export const SETTINGS_ROOT = '/admin/settings';

export type SettingsGroupId = 'instance' | 'access' | 'integrations' | 'operations';

export type SettingsGroup = {
  /** Prefix of the `group.{id}.label` keys. */
  id: SettingsGroupId;
  icon: LucideIcon;
  sections: readonly SettingsSectionId[];
};

/** The rail's four groups, and the order of their tabs. */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  { id: 'instance', icon: Building2, sections: ['identity', 'regional'] },
  { id: 'access', icon: ShieldCheck, sections: ['security', 'sso', 'accounts'] },
  { id: 'integrations', icon: Plug, sections: ['integrations', 'ai', 'notifications'] },
  { id: 'operations', icon: Wrench, sections: ['backups', 'onboarding'] },
];

/** A group's sections, in the order of its tabs. */
export function groupSections(group: SettingsGroup): SettingsSection[] {
  return group.sections.map(
    (id) => SETTINGS_SECTIONS.find((section) => section.id === id) as SettingsSection,
  );
}

/** A section address's group, or `null` outside the settings. */
export function settingsGroupOf(pathname: string): SettingsGroup | null {
  const section = SETTINGS_SECTIONS.find((entry) => entry.href === pathname);
  if (!section) return null;
  return SETTINGS_GROUPS.find((group) => group.sections.includes(section.id)) ?? null;
}

/**
 * Finds a section by its path. Throws rather than return `undefined`: a page that
 * does not find itself in the list is a wiring error, not a run-time case —
 * better it fails at the first render than show a panel without a title.
 */
export function settingsSection(href: string): SettingsSection {
  const found = SETTINGS_SECTIONS.find((entry) => entry.href === href);
  if (!found) throw new Error(`Unknown settings section: ${href}`);
  return found;
}
