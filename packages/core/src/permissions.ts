/**
 * RBAC vocabulary shared by the panel, the worker and the seed. A permission is
 * a `resource:action` string.
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
  'backup:read',
  'backup:manage',
  'backup:restore',
  'workload:read',
  'workload:manage',
  'workload:exec',
  'scan:read',
  'scan:configure',
  'job:read',
  'job:manage',
  'monitor:read',
  'monitor:manage',
  'maintenance:read',
  'maintenance:manage',
  'status_page:manage',
  'status_page:announce',
  'audit:read',
  'settings:read',
  'settings:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * The permissions' screen labels.
 *
 * They live here because the panel, the worker and the seed share the RBAC
 * vocabulary — but only the **keys** are shared: these sentences only serve the
 * role editor, which renders them in the instance's language through
 * `translator(permissionDescriptions, language)`.
 *
 * `satisfies Record<Permission, string>` is the guard that counts: a permission
 * added to `PERMISSIONS` without its description no longer compiles.
 */
const descriptionsFr = {
  'user:read': 'Consulter les utilisateurs',
  'user:manage': 'Créer, désactiver et changer le rôle des utilisateurs',
  // Distinct from `user:manage`: removing someone's second factor lifts a
  // protection on their account. Managing users day to day should not give that
  // power without it being explicitly wanted.
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
  // Covers the three gestures that interrupt service without touching the
  // version: restart, stop, start. A separate `deployment:stop` permission would
  // have produced a role able to restart but not to stop, whereas a restart *is*
  // a stop followed by a start — same scope, same consequence for visitors,
  // nothing destroyed in either case.
  'deployment:restart': 'Redémarrer, arrêter et relancer une application déployée',
  'deployment:destroy': 'Détruire un déploiement',
  // Destroying removes the application from the machine; purging erases the trace
  // in the database. Two different gestures, two permissions.
  'deployment:purge': "Effacer des déploiements de l'historique",
  'backup:read': 'Consulter les sauvegardes et leur politique',
  'backup:manage': 'Régler les sauvegardes des applications et en lancer une',
  'backup:restore': "Restaurer une sauvegarde — remplace les données de l'application",
  // "Workload" rather than "container": on a K3s target they are pods. The Docker
  // word has no place in the shared vocabulary.
  'workload:read': "Consulter les charges qui tournent sur une cible",
  'workload:manage':
    "Démarrer, arrêter, redémarrer, lire le journal, mettre à jour et supprimer les charges d'une cible",
  'workload:exec': "Exécuter des commandes dans les charges d'une cible",
  'scan:read': 'Consulter les scans et leurs findings',
  // Accepting a vulnerability decides, like the threshold, what blocks a release:
  // the same gesture, the same permission.
  'scan:configure':
    "Choisir les scanners et le seuil de blocage, d'une application comme de l'instance, et accepter une faille connue",
  'job:read': 'Consulter les tâches planifiées',
  'job:manage': 'Créer et désactiver des tâches planifiées',
  'monitor:read': 'Consulter la supervision des sites et leur historique',
  'monitor:manage': 'Créer, modifier et suspendre une sonde de supervision',
  'maintenance:read': 'Consulter les fenêtres de maintenance et les alertes retenues',
  'maintenance:manage': 'Planifier, modifier et terminer une fenêtre de maintenance',
  'status_page:manage':
    'Composer et publier les pages de statut publiques — ce que des inconnus verront',
  // Distinct from `status_page:manage`: saying "we are investigating" during an
  // outage is an operations gesture; deciding what a page shows is not.
  'status_page:announce':
    'Publier des annonces sur les pages de statut pendant une panne ou une maintenance',
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
  'backup:read': 'Read backups and their policy',
  'backup:manage': 'Configure application backups and run one',
  'backup:restore': 'Restore a backup — replaces the application’s data',
  'workload:read': 'Read the workloads running on a target',
  'workload:manage':
    'Start, stop, restart, read the log of, update and delete a target’s workloads',
  'workload:exec': 'Run commands inside a target’s workloads',
  'scan:read': 'Read scans and their findings',
  'scan:configure':
    'Choose the scanners and the blocking threshold, per application or instance-wide, and accept a known vulnerability',
  'job:read': 'Read scheduled jobs',
  'job:manage': 'Create and disable scheduled jobs',
  'monitor:read': 'Read site monitoring and its history',
  'monitor:manage': 'Create, change and pause a monitoring probe',
  'maintenance:read': 'Read maintenance windows and the alerts they hold',
  'maintenance:manage': 'Schedule, change and end a maintenance window',
  'status_page:manage': 'Compose and publish public status pages — what strangers will see',
  'status_page:announce': 'Post announcements on status pages during an outage or a maintenance',
  'audit:read': 'Read the activity log',
  'settings:read': 'Read the instance settings',
  'settings:manage': 'Change the instance settings, including access to the AI model',
};

export const permissionDescriptions = { fr: descriptionsFr, en: descriptionsEn };

/**
 * @deprecated Use `permissionDescriptions`, rendered through
 * `translator(permissionDescriptions, language)`.
 *
 * Kept for the seed: it renders nothing on screen, it **stores** these
 * sentences in `permissions.description` as values. The source stays French,
 * like the rest of the database.
 */
export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = descriptionsFr;

/**
 * Roles installed on an empty database. They are only **starting values**: the
 * authority, at runtime, is the `roles` table. An administrator can create
 * other roles and change these ones' permissions.
 */
export const SEEDED_ROLES = ['admin', 'operator', 'auditor', 'viewer', 'no-access'] as const;

export type SeededRoleKey = (typeof SEEDED_ROLES)[number];

/**
 * A role's key. Deliberately a string and not a union: roles are data, not
 * code. A frozen union would require recompiling the panel to create a role.
 */
export type RoleKey = string;

/**
 * The only immutable role. It always carries every permission and can be
 * neither renamed, nor emptied, nor deleted — it is the safeguard that prevents
 * locking yourself out of your own panel.
 */
export const LOCKED_ROLE = 'admin' as const;

export function isLockedRole(key: string): boolean {
  return key === LOCKED_ROLE;
}

/** Role key: kebab-case, like the rest of the project's slugs. */
export const ROLE_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The role of an account created by public sign-up: no permission, until an
 * administrator chooses one. Sign-up says nothing about who signs up — opening
 * the slightest read to it meant opening it to anyone.
 */
export const SIGNUP_ROLE = 'no-access' satisfies SeededRoleKey;

/** Every permission whose action is `read`. */
const READ_ONLY = PERMISSIONS.filter((p) => p.endsWith(':read'));

/**
 * The reads that concern the platform's administration rather than its
 * operation: who signed in and from where (the audit log carries IP addresses
 * and emails), who has an account, which roles exist, how the instance is set.
 * They go to the auditor, not to the viewer.
 */
const ADMINISTRATION_READS: ReadonlySet<Permission> = new Set<Permission>([
  'user:read',
  'role:read',
  'audit:read',
  'settings:read',
]);

/** Operations reads: what runs, where, and in what state. */
const OPERATION_READS = READ_ONLY.filter((p) => !ADMINISTRATION_READS.has(p));

/**
 * The starting roles. Their `label` and `description` are **not** screen
 * strings: the seed writes them once, into `roles`, on an empty database, and
 * an administrator renames them afterwards. They are in English, like every
 * default of a new instance; instances seeded earlier keep their French labels,
 * which the seed never rewrites.
 */
export const ROLE_DEFINITIONS: Record<
  SeededRoleKey,
  { label: string; description: string; permissions: readonly Permission[] }
> = {
  admin: {
    label: 'Administrator',
    description: 'Full access, including user and role management',
    permissions: PERMISSIONS,
  },
  operator: {
    label: 'Operator',
    description: 'Deploys and operates, without administering the platform',
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
      // Backing up is part of operations; restoring replaces data, and stays with the
      // administrator as long as they do not delegate it.
      'backup:read',
      'backup:manage',
      'scan:read',
      // Choosing the scanners is part of the deployment gesture: an operator who
      // deploys must be able to decide what is scanned and when it blocks.
      'scan:configure',
      // Working on a machine without waking up on-call is part of operations.
      'maintenance:read',
      'maintenance:manage',
      // Keeping visitors informed of an outage being repaired, too.
      'status_page:announce',
    ],
  },
  auditor: {
    label: 'Auditor',
    description: 'Read-only access to the whole platform, activity log and accounts included',
    permissions: READ_ONLY,
  },
  viewer: {
    label: 'Viewer',
    description: 'Read-only access to operations: targets, applications, deployments, monitoring',
    permissions: OPERATION_READS,
  },
  'no-access': {
    label: 'No access',
    description: 'No permission: the role of a sign-up, until an administrator chooses one',
    permissions: [],
  },
};

/**
 * The **sensitive** permissions: those that give control over something other
 * than reads — an account or a role, the instance, a machine (its SSH access,
 * what runs on it), code run on a machine, data destroyed or replaced.
 *
 * It is the list that decides, when the instance requires it, who must carry a
 * second factor: a role carrying a single one is bound by it. Deploying is part
 * of it — deploying whatever you want is running whatever you want on the
 * machine.
 */
export const SENSITIVE_PERMISSIONS: readonly Permission[] = [
  // accounts and roles
  'user:manage',
  'user:reset-2fa',
  'role:manage',
  // the instance
  'settings:manage',
  // machines
  'target:create',
  'target:update',
  'target:delete',
  'workload:manage',
  'workload:exec',
  // code run on a machine
  'application:create',
  'application:update',
  'deployment:create',
  // data destroyed or replaced
  'application:delete',
  'backup:restore',
  'deployment:destroy',
  'deployment:purge',
];

const SENSITIVE_SET: ReadonlySet<string> = new Set<string>(SENSITIVE_PERMISSIONS);

export function isSensitivePermission(permission: string): boolean {
  return SENSITIVE_SET.has(permission);
}

/** When the instance requires a second factor. */
export const TWO_FACTOR_POLICIES = ['off', 'sensitive', 'all'] as const;
export type TwoFactorPolicy = (typeof TWO_FACTOR_POLICIES)[number];

/**
 * Must this account carry a second factor? Depending on the instance's policy
 * and the permissions it holds: `sensitive` binds any role carrying a single
 * sensitive one — the administrator always.
 */
export function requiresTwoFactor(
  permissions: readonly string[],
  policy: TwoFactorPolicy,
): boolean {
  if (policy === 'all') return true;
  if (policy === 'off') return false;
  return permissions.some(isSensitivePermission);
}

/** Splits `resource:action`. */
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
 * Permissions grouped by resource, in declaration order.
 *
 * `describe` comes from the caller: grouping is a matter of structure, the
 * sentence a matter of screen, and only the screen knows the instance's
 * language. Without it, we fall back on French, which is the source.
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

/** Resource labels, for the role editing screen. */
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
  maintenance: 'Fenêtres de maintenance',
  status_page: 'Pages de statut',
  backup: 'Sauvegardes',
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
  maintenance: 'Maintenance windows',
  status_page: 'Status pages',
  backup: 'Backups',
  audit: 'Activity log',
  settings: 'Instance settings',
};

export const resourceLabels = { fr: resourcesFr, en: resourcesEn };

/**
 * A resource's label, or its raw name.
 *
 * A resource is a free string — the left half of a permission key —, not a
 * dictionary key: falling back on the raw name is what allows adding a
 * permission before its label.
 */
export function resourceLabelOf(resource: string, language: UiLanguage): string {
  const table: Record<string, string> = resourceLabels[language] ?? resourcesFr;
  return table[resource] ?? resourcesFr[resource as keyof typeof resourcesFr] ?? resource;
}
