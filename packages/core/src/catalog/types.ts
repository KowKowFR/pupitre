import type { UiLanguage } from '../i18n.js';
import type { AppSpecInput } from '../spec/index.js';

/**
 * Le catalogue — des applications prêtes à l'emploi, décrites en AppSpec.
 *
 * Un modèle n'est **pas** un `compose.yml` recopié d'un README : c'est une
 * fonction qui rend une AppSpec neutre, validée par le même schéma que celles
 * qu'on écrit à la main ou que l'IA propose. Elle ne connaît ni Docker ni
 * Kubernetes, et se déploie donc sur les deux runtimes.
 *
 * Ce que l'AppSpec ne sait pas dire, le catalogue ne le dit pas non plus : pas
 * de commande de démarrage, pas d'interpolation de variables, pas de socket
 * Docker monté. Une image qui en a besoin (MinIO, Keycloak, Portainer…) n'y
 * entre pas — l'y faire entrer demanderait un champ runtime-spécifique.
 */

export const CATALOG_CATEGORIES = [
  'monitoring',
  'analytics',
  'content',
  'automation',
  'devtools',
  'productivity',
  'media',
  'security',
  'demo',
] as const;
export type CatalogCategory = (typeof CATALOG_CATEGORIES)[number];

/** Ce que l'opérateur choisit au moment d'installer. */
export type CatalogParams = {
  /** Nom de l'application : son slug, et le `name` de l'AppSpec. */
  name: string;
  /** Domaine public. Absent : le driver publie sur un port alloué de la cible. */
  host: string | null;
  tls: boolean;
  /** Adresse de la personne qui installe, pour les images qui veulent un e-mail d'admin. */
  email: string;
};

export type CatalogText = Record<UiLanguage, string>;

export type CatalogTemplate = {
  /** Identifiant stable, en kebab-case — il sert d'URL et de nom par défaut. */
  id: string;
  /** Nom du produit, tel que son éditeur l'écrit. */
  name: string;
  category: CatalogCategory;
  website: string;
  summary: CatalogText;
  /**
   * Ce qu'il faut faire au premier accès : terminer un assistant, créer le
   * premier compte. Dit avant l'installation, pas découvert après.
   */
  firstRun: CatalogText;
  /**
   * Secrets que l'opérateur saisit à l'installation : ceux dont il aura besoin
   * pour se connecter. Les autres sont générés, et un secret généré ne se
   * relit jamais — un mot de passe d'administration généré serait perdu.
   */
  askedSecrets: readonly string[];
  /**
   * L'application ne fonctionne correctement que derrière son domaine (liens
   * absolus, cookies, callbacks). Sans lui, elle démarre mais se comporte mal.
   */
  wantsHost: boolean;
  build(params: CatalogParams): AppSpecInput;
};
