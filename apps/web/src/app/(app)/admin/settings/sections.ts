import {
  Bell,
  Compass,
  DatabaseBackup,
  Globe,
  LogIn,
  Plug,
  ScanSearch,
  Signature,
  Sparkles,
  UserLock,
  type LucideIcon,
} from 'lucide-react';

/**
 * Le découpage des paramètres, en un seul endroit.
 *
 * La navigation latérale et le sommaire lisent la même liste : une section
 * ajoutée apparaît dans les deux sans qu'on y pense, et surtout aucune des deux
 * ne peut mentir sur l'existence de l'autre.
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
  { href: '/admin/settings/integrations', id: 'integrations', icon: Plug },
  { href: '/admin/settings/sauvegardes', id: 'backups', icon: DatabaseBackup },
  { href: '/admin/settings/demarrage', id: 'onboarding', icon: Compass },
];

/** Racine de la section — le sommaire. Première entrée du rail, et rien d'autre. */
export const SETTINGS_OVERVIEW = {
  href: '/admin/settings',
} as const;

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
