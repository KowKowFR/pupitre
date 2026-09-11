/**
 * Vocabulaire RBAC partagé par le panel, le worker et le seed.
 * Une permission est une chaîne `ressource:action`.
 */

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

export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
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
  'deployment:restart': 'Redémarrer une application en marche',
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
};

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


/** Permissions groupées par ressource, dans l'ordre de déclaration. */
export function permissionsByResource(): Array<{
  resource: string;
  permissions: Array<{ key: Permission; action: string; description: string }>;
}> {
  const groups = new Map<string, Array<{ key: Permission; action: string; description: string }>>();

  for (const key of PERMISSIONS) {
    const { resource, action } = splitPermission(key);
    const bucket = groups.get(resource) ?? [];
    bucket.push({ key, action, description: PERMISSION_DESCRIPTIONS[key] });
    groups.set(resource, bucket);
  }

  return [...groups.entries()].map(([resource, permissions]) => ({ resource, permissions }));
}

/** Libellés français des ressources, pour l'écran d'édition des rôles. */
export const RESOURCE_LABELS: Record<string, string> = {
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
};
