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
 * Le découpage des paramètres, en un seul endroit.
 *
 * Dix sections, rangées en quatre groupes : le rail montre les groupes, les
 * onglets d'un groupe montrent ses sections. Les deux lisent cette liste —
 * une section ajoutée à un groupe apparaît dans ses onglets sans qu'on y
 * pense. Chaque section garde son adresse : un lien d'hier marche toujours.
 *
 * Les sections sont des **intentions**, pas des sections du JSONB. Personne ne
 * vient « éditer la clé `security` » : on vient couper les scans, ou changer le
 * nom du panel.
 *
 * ── Pourquoi la prose n'est plus ici ────────────────────────────────────────
 * L'étiquette, le titre et le « ce que la section gouverne » sont du texte
 * affiché : ils vivent donc dans le dictionnaire, sous `section.{id}.*`. Ce
 * catalogue ne garde que ce qui n'a pas de langue — l'adresse, l'icône, et
 * l'`id` qui permet à chaque écran de composer sa clé sans table de
 * correspondance.
 */

/** L'identité stable d'une section. C'est elle qui préfixe ses clés de texte. */
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
  /** Chemin absolu. Aussi la clé d'activation de la navigation (égalité stricte). */
  href: string;
  /** Préfixe des clés `section.{id}.label`, `.title` et `.governs`. */
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

/** Racine des paramètres : elle mène au premier onglet du premier groupe. */
export const SETTINGS_ROOT = '/admin/settings';

export type SettingsGroupId = 'instance' | 'access' | 'integrations' | 'operations';

export type SettingsGroup = {
  /** Préfixe des clés `group.{id}.label`. */
  id: SettingsGroupId;
  icon: LucideIcon;
  sections: readonly SettingsSectionId[];
};

/** Les quatre groupes du rail, et l'ordre de leurs onglets. */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  { id: 'instance', icon: Building2, sections: ['identity', 'regional'] },
  { id: 'access', icon: ShieldCheck, sections: ['security', 'sso', 'accounts'] },
  { id: 'integrations', icon: Plug, sections: ['integrations', 'ai', 'notifications'] },
  { id: 'operations', icon: Wrench, sections: ['backups', 'onboarding'] },
];

/** Les sections d'un groupe, dans l'ordre de ses onglets. */
export function groupSections(group: SettingsGroup): SettingsSection[] {
  return group.sections.map(
    (id) => SETTINGS_SECTIONS.find((section) => section.id === id) as SettingsSection,
  );
}

/** Le groupe d'une adresse de section, ou `null` hors des paramètres. */
export function settingsGroupOf(pathname: string): SettingsGroup | null {
  const section = SETTINGS_SECTIONS.find((entry) => entry.href === pathname);
  if (!section) return null;
  return SETTINGS_GROUPS.find((group) => group.sections.includes(section.id)) ?? null;
}

/**
 * Retrouve une section par son chemin. Lève plutôt que de rendre `undefined` :
 * une page qui ne se retrouve pas dans la liste est une erreur de câblage, pas
 * un cas d'exécution — mieux vaut qu'elle échoue au premier rendu que
 * d'afficher un panneau sans titre.
 */
export function settingsSection(href: string): SettingsSection {
  const found = SETTINGS_SECTIONS.find((entry) => entry.href === href);
  if (!found) throw new Error(`Section de paramètres inconnue : ${href}`);
  return found;
}
