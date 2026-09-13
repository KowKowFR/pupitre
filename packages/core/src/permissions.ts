/**
 * Vocabulaire RBAC partagé par le panel, le worker et le seed.
 * Une permission est une chaîne `ressource:action`.
 */

import type { Translated, UiLanguage } from './i18n.js';

export const PERMISSIONS = [
  'user:read',
  'user:manage',
  'user:reset-2fa',
  'role:read',
  'role:manage',
  'target:read',
  'target:create',
  'target:update',
  'target:delete',
  'application:read',
  'application:create',
  'application:update',
  'application:delete',
  'deployment:read',
  'deployment:create',
  'deployment:rollback',
  'deployment:restart',
  'deployment:destroy',
  'deployment:purge',
  'workload:read',
  'workload:manage',
  'scan:read',
  'scan:configure',
  'job:read',
  'job:manage',
  'monitor:read',
  'monitor:manage',
  'audit:read',
  'settings:read',
  'settings:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Les libellés d'écran des permissions.
 *
 * Ils vivent ici parce que le panel, le worker et le seed partagent le
 * vocabulaire RBAC — mais seules les **clés** sont partagées : ces phrases-là
 * ne servent qu'à l'éditeur de rôles, qui les rend dans la langue de l'instance
 * via `translator(permissionDescriptions, language)`.
 *
 * Le `satisfies Record<Permission, string>` est la garde qui compte : une
 * permission ajoutée à `PERMISSIONS` sans sa description ne compile plus.
 */
const descriptionsFr = {
  'user:read': 'Consulter les utilisateurs',
  'user:manage': 'Créer, désactiver et changer le rôle des utilisateurs',
  // Distincte de `user:manage` : retirer le second facteur de quelqu'un lève
  // une protection sur son compte. Gérer les utilisateurs au quotidien ne
  // devrait pas donner ce pouvoir sans qu'on l'ait explicitement voulu.
  'user:reset-2fa': "Réinitialiser le second facteur d'un utilisateur",
  'role:read': 'Consulter les rôles et leurs permissions',
  'role:manage': 'Modifier les rôles et leurs permissions',
  'target:read': 'Consulter les machines cibles',
  'target:create': 'Déclarer une machine cible',
  'target:update': 'Modifier une machine cible',
  'target:delete': 'Supprimer une machine cible',
  'application:read': 'Consulter les applications',
  'application:create': 'Créer une application',
  'application:update': 'Modifier une application',
  'application:delete': 'Supprimer une application',
  'deployment:read': 'Consulter les déploiements et leurs logs',
  'deployment:create': 'Lancer un déploiement',
  'deployment:rollback': 'Revenir à la version précédente',
  // Couvre les trois gestes qui interrompent le service sans toucher à la
  // version : redémarrer, arrêter, relancer. Une permission `deployment:stop`
  // séparée aurait produit un rôle capable de redémarrer mais pas d'arrêter,
  // alors qu'un redémarrage *est* un arrêt suivi d'un démarrage — même portée,
  // même conséquence pour les visiteurs, rien de détruit dans les deux cas.
  'deployment:restart': 'Redémarrer, arrêter et relancer une application déployée',
  'deployment:destroy': 'Détruire un déploiement',
  // Détruire retire l'application de la machine ; purger efface la trace en base.
  // Deux gestes différents, deux permissions.
  'deployment:purge': "Effacer des déploiements de l'historique",
  // « Charge » plutôt que « conteneur » : sur une cible K3s ce sont des pods.
  // Le mot Docker n'a pas sa place dans le vocabulaire partagé.
  'workload:read': "Consulter les charges qui tournent sur une cible",
  'workload:manage': 'Supprimer et mettre à jour les charges d\'une cible',
  'scan:read': 'Consulter les scans et leurs findings',
  'scan:configure': 'Choisir les scanners et le seuil de blocage',
  'job:read': 'Consulter les tâches planifiées',
  'job:manage': 'Créer et désactiver des tâches planifiées',
  'monitor:read': 'Consulter la supervision des sites et leur historique',
  'monitor:manage': 'Créer, modifier et suspendre une sonde de supervision',
  'audit:read': "Consulter les logs d'activité",
  'settings:read': "Consulter les paramètres de l'instance",
  'settings:manage': "Modifier les paramètres de l'instance, y compris l'accès au modèle d'IA",
} as const satisfies Record<Permission, string>;

const descriptionsEn: Translated<typeof descriptionsFr> = {
  'user:read': 'Read users',
  'user:manage': 'Create users, disable them and change their role',
  'user:reset-2fa': 'Reset a user’s second factor',
  'role:read': 'Read roles and their permissions',
  'role:manage': 'Change roles and their permissions',
  'target:read': 'Read target machines',
  'target:create': 'Declare a target machine',
  'target:update': 'Change a target machine',
  'target:delete': 'Delete a target machine',
  'application:read': 'Read applications',
  'application:create': 'Create an application',
  'application:update': 'Change an application',
  'application:delete': 'Delete an application',
  'deployment:read': 'Read deployments and their logs',
  'deployment:create': 'Start a deployment',
  'deployment:rollback': 'Go back to the previous version',
  'deployment:restart': 'Restart a running application',
  'deployment:destroy': 'Destroy a deployment',
  'deployment:purge': 'Erase deployments from the history',
  'workload:read': 'Read the workloads running on a target',
  'workload:manage': 'Delete and update a target’s workloads',
  'scan:read': 'Read scans and their findings',
  'scan:configure': 'Choose the scanners and the blocking threshold',
  'job:read': 'Read scheduled jobs',
  'job:manage': 'Create and disable scheduled jobs',
  'monitor:read': 'Read site monitoring and its history',
  'monitor:manage': 'Create, change and pause a monitoring probe',
  'audit:read': 'Read the activity log',
  'settings:read': 'Read the instance settings',
  'settings:manage': 'Change the instance settings, including access to the AI model',
};

export const permissionDescriptions = { fr: descriptionsFr, en: descriptionsEn };

/**
 * @deprecated Utiliser `permissionDescriptions`, rendu par
 * `translator(permissionDescriptions, language)`.
 *
 * Conservé pour le seed : lui ne rend rien à l'écran, il **range** ces phrases
 * dans `permissions.description` comme des valeurs. La source reste le
 * français, comme le reste de la base.
 */
export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = descriptionsFr;

/**
 * Rôles installés sur une base vierge. Ce ne sont que des **valeurs de départ** :
 * l'autorité, à l'exécution, est la table `roles`. Un administrateur peut créer
 * d'autres rôles et modifier les permissions de ceux-ci.
 */
export const SEEDED_ROLES = ['admin', 'operator', 'viewer'] as const;

/** @deprecated Utiliser `SEEDED_ROLES` — conservé le temps de la migration. */
export const ROLES = SEEDED_ROLES;

export type SeededRoleKey = (typeof SEEDED_ROLES)[number];

/**
 * Clé d'un rôle. Volontairement une chaîne et non une union : les rôles sont
 * des données, pas du code. Une union figée obligerait à recompiler le panel
 * pour créer un rôle.
 */
export type RoleKey = string;

/**
 * Le seul rôle immuable. Il porte toujours l'intégralité des permissions et ne
 * peut être ni renommé, ni vidé, ni supprimé — c'est le garde-fou qui empêche
 * de se verrouiller hors de son propre panel.
 */
export const LOCKED_ROLE = 'admin' as const;

export function isLockedRole(key: string): boolean {
  return key === LOCKED_ROLE;
}

/** Clé de rôle : kebab-case, comme les slugs du reste du projet. */
export const ROLE_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Toute permission dont l'action est `read`. */
const READ_ONLY = PERMISSIONS.filter((p) => p.endsWith(':read'));

/**
 * Les rôles de départ. Leurs `label` et `description` ne sont **pas** des
 * chaînes d'écran : le seed les écrit en base, dans `roles`, où un
 * administrateur les renomme ensuite. Les traduire figerait la langue au
 * premier démarrage et laisserait la colonne incohérente.
 */
export const ROLE_DEFINITIONS: Record<
  SeededRoleKey,
  { label: string; description: string; permissions: readonly Permission[] }
> = {
  admin: {
    label: 'Administrateur',
    description: 'Accès complet, y compris la gestion des utilisateurs et des rôles',
    permissions: PERMISSIONS,
  },
  operator: {
    label: 'Opérateur',
    description: 'Déploie et exploite, sans administrer la plateforme',
    permissions: [
      'target:read',
      'target:create',
      'target:update',
      'application:read',
      'application:create',
      'application:update',
      'application:delete',
      'deployment:read',
      'deployment:create',
      'deployment:rollback',
      'deployment:restart',
      'scan:read',
      // Choisir les scanners fait partie du geste de déploiement : un opérateur
      // qui déploie doit pouvoir décider ce qu'on analyse et quand ça bloque.
      'scan:configure',
    ],
  },
  viewer: {
    label: 'Observateur',
    description: 'Lecture seule sur toute la plateforme',
    permissions: READ_ONLY,
  },
};

/** Découpe `ressource:action`. */
export function splitPermission(permission: Permission): {
  resource: string;
  action: string;
} {
  const separator = permission.indexOf(':');
  return {
    resource: permission.slice(0, separator),
    action: permission.slice(separator + 1),
  };
}

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}


/**
 * Permissions groupées par ressource, dans l'ordre de déclaration.
 *
 * `describe` vient de l'appelant : le regroupement est une affaire de
 * structure, la phrase une affaire d'écran, et seul l'écran connaît la langue
 * de l'instance. Sans lui, on retombe sur le français, qui est la source.
 */
export function permissionsByResource(
  describe: (key: Permission) => string = (key) => descriptionsFr[key],
): Array<{
  resource: string;
  permissions: Array<{ key: Permission; action: string; description: string }>;
}> {
  const groups = new Map<string, Array<{ key: Permission; action: string; description: string }>>();

  for (const key of PERMISSIONS) {
    const { resource, action } = splitPermission(key);
    const bucket = groups.get(resource) ?? [];
    bucket.push({ key, action, description: describe(key) });
    groups.set(resource, bucket);
  }

  return [...groups.entries()].map(([resource, permissions]) => ({ resource, permissions }));
}

/** Libellés des ressources, pour l'écran d'édition des rôles. */
const resourcesFr = {
  user: 'Utilisateurs',
  role: 'Rôles',
  target: 'Machines cibles',
  application: 'Applications',
  deployment: 'Déploiements',
  workload: 'Charges des cibles',
  scan: 'Sécurité',
  job: 'Tâches planifiées',
  monitor: 'Supervision de sites',
  audit: "Logs d'activité",
  settings: "Paramètres de l'instance",
} as const;

const resourcesEn: Translated<typeof resourcesFr> = {
  user: 'Users',
  role: 'Roles',
  target: 'Target machines',
  application: 'Applications',
  deployment: 'Deployments',
  workload: 'Target workloads',
  scan: 'Security',
  job: 'Scheduled jobs',
  monitor: 'Site monitoring',
  audit: 'Activity log',
  settings: 'Instance settings',
};

export const resourceLabels = { fr: resourcesFr, en: resourcesEn };

/**
 * Le libellé d'une ressource, ou son nom brut.
 *
 * Une ressource est une chaîne libre — la moitié gauche d'une clé de
 * permission —, pas une clé de dictionnaire : le repli sur le nom brut est ce
 * qui permet d'ajouter une permission avant son libellé.
 */
export function resourceLabelOf(resource: string, language: UiLanguage): string {
  const table: Record<string, string> = resourceLabels[language] ?? resourcesFr;
  return table[resource] ?? resourcesFr[resource as keyof typeof resourcesFr] ?? resource;
}
