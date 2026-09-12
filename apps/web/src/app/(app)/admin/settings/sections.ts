import { Bell, Compass, Globe, ScanSearch, Signature, Sparkles, type LucideIcon } from 'lucide-react';

/**
 * Le découpage des paramètres, en un seul endroit.
 *
 * La navigation latérale et le sommaire lisent la même liste : une section
 * ajoutée apparaît dans les deux sans qu'on y pense, et surtout aucune des deux
 * ne peut mentir sur l'existence de l'autre.
 *
 * Les sections sont des **intentions**, pas des sections du JSONB. Personne ne
 * vient « éditer la clé `security` » : on vient couper les scans, ou changer le
 * nom du panel. `governs` dit à chaque fois ce que le réglage commande et où
 * l'effet se voit — un intitulé de champ tout seul ne situe rien.
 */
export type SettingsSection = {
  /** Chemin absolu. Aussi la clé d'activation de la navigation (égalité stricte). */
  href: string;
  /** Étiquette courte, pour le rail. */
  label: string;
  /** Titre de la page, et du panneau dans le sommaire. */
  title: string;
  /** Ce que la section gouverne, et où ça se voit. */
  governs: string;
  icon: LucideIcon;
};

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    href: '/admin/settings/identite',
    label: 'Identité',
    title: "Identité de l'instance",
    governs:
      "Le nom et le sous-titre que le panel affiche de lui-même : en haut du rail de navigation, dans le titre de l'onglet du navigateur, et en tête de l'assistant de démarrage.",
    icon: Signature,
  },
  {
    href: '/admin/settings/regionalisation',
    label: 'Régionalisation',
    title: 'Régionalisation',
    governs:
      "Le fuseau, la langue et la forme de toutes les dates du panel — tableaux, journaux, horodatages des logs d'activité —, serveur et navigateur compris. Le fuseau sert aussi de défaut aux tâches planifiées créées ensuite.",
    icon: Globe,
  },
  {
    href: '/admin/settings/securite',
    label: 'Analyse de sécurité',
    title: 'Analyse de sécurité',
    governs:
      "Le scan des images avant mise en ligne : quels scanners tournent, et à partir de quelle sévérité un finding empêche le déploiement. Le réglage vaut pour toute l'instance, y compris les déploiements lancés depuis l'API.",
    icon: ScanSearch,
  },
  {
    href: '/admin/settings/notifications',
    label: 'Notifications',
    title: 'Notifications',
    governs:
      "Qui est prévenu, comment, et de quoi : e-mail, Telegram, Discord ou webhook. Les alertes partent des mêmes événements que les logs d'activité — un déploiement en échec, un scan qui bloque, un geste de sécurité — mais elles vont chercher quelqu'un au lieu d'attendre qu'on vienne lire.",
    icon: Bell,
  },
  {
    href: '/admin/settings/ia',
    label: 'Intelligence artificielle',
    title: 'Intelligence artificielle',
    governs:
      "Le fournisseur, le modèle et la clé qui servent à générer une AppSpec depuis une description, sur l'écran « Nouvelle application ». Sans clé ni variable d'environnement, la génération reste hors service.",
    icon: Sparkles,
  },
  {
    href: '/admin/settings/demarrage',
    label: 'Assistant de démarrage',
    title: 'Assistant de démarrage',
    governs:
      "Le parcours de prise en main proposé à l'arrivée sur une instance vierge. On le relance d'ici quand il a été terminé ou abandonné — c'est un raccourci vers un parcours, pas un réglage de plus.",
    icon: Compass,
  },
];

/** Racine de la section — le sommaire. Première entrée du rail, et rien d'autre. */
export const SETTINGS_OVERVIEW = {
  href: '/admin/settings',
  label: 'Sommaire',
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
