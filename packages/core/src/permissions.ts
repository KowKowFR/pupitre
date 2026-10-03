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
  'backup:read': 'Consulter les sauvegardes et leur politique',
  'backup:manage': 'Régler les sauvegardes des applications et en lancer une',
  'backup:restore': "Restaurer une sauvegarde — remplace les données de l'application",
  // « Charge » plutôt que « conteneur » : sur une cible K3s ce sont des pods.
  // Le mot Docker n'a pas sa place dans le vocabulaire partagé.
  'workload:read': "Consulter les charges qui tournent sur une cible",
  'workload:manage':
    "Démarrer, arrêter, redémarrer, lire le journal, mettre à jour et supprimer les charges d'une cible",
  'workload:exec': "Exécuter des commandes dans les charges d'une cible",
  'scan:read': 'Consulter les scans et leurs findings',
  // Accepter une faille décide, comme le seuil, de ce qui bloque une mise en
  // ligne : le même geste, la même permission.
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
  // Distincte de `status_page:manage` : dire « on enquête » pendant une panne
  // est un geste d'exploitation ; décider de ce qu'une page montre, non.
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
export const SEEDED_ROLES = ['admin', 'operator', 'auditor', 'viewer', 'no-access'] as const;

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

/**
 * Le rôle d'un compte créé par l'inscription publique : aucune permission, en
 * attendant qu'un administrateur en choisisse un. L'inscription ne dit rien de
 * qui s'inscrit — lui ouvrir la moindre lecture, c'était la lui ouvrir à
 * n'importe qui.
 */
export const SIGNUP_ROLE = 'no-access' satisfies SeededRoleKey;

/** Toute permission dont l'action est `read`. */
const READ_ONLY = PERMISSIONS.filter((p) => p.endsWith(':read'));

/**
 * Les lectures qui regardent l'administration de la plateforme plutôt que son
 * exploitation : qui s'est connecté et d'où (le journal porte des adresses IP
 * et des e-mails), qui a un compte, quels rôles existent, comment l'instance
 * est réglée. Elles vont à l'auditeur, pas à l'observateur.
 */
const ADMINISTRATION_READS: ReadonlySet<Permission> = new Set<Permission>([
  'user:read',
  'role:read',
  'audit:read',
  'settings:read',
]);

/** Les lectures de l'exploitation : ce qui tourne, où, et dans quel état. */
const OPERATION_READS = READ_ONLY.filter((p) => !ADMINISTRATION_READS.has(p));

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
      // Sauvegarder fait partie de l'exploitation ; restaurer remplace des
      // données, et reste à l'administrateur tant qu'il ne le délègue pas.
      'backup:read',
      'backup:manage',
      'scan:read',
      // Choisir les scanners fait partie du geste de déploiement : un opérateur
      // qui déploie doit pouvoir décider ce qu'on analyse et quand ça bloque.
      'scan:configure',
      // Intervenir sur une machine sans réveiller l'astreinte fait partie de
      // l'exploitation.
      'maintenance:read',
      'maintenance:manage',
      // Tenir les visiteurs au courant d'une panne qu'on est en train de
      // réparer, aussi.
      'status_page:announce',
    ],
  },
  auditor: {
    label: 'Auditeur',
    description: "Lecture seule sur toute la plateforme, journal d'activité et comptes compris",
    permissions: READ_ONLY,
  },
  viewer: {
    label: 'Observateur',
    description:
      "Lecture seule de l'exploitation : cibles, applications, déploiements, supervision",
    permissions: OPERATION_READS,
  },
  'no-access': {
    label: 'Sans accès',
    description:
      "Aucune permission : le rôle d'une inscription, en attendant qu'un administrateur en choisisse un",
    permissions: [],
  },
};

/**
 * Les permissions **sensibles** : celles qui donnent la main sur autre chose
 * que des lectures — un compte ou un rôle, l'instance, une machine (ses accès
 * SSH, ce qui y tourne), du code exécuté sur une machine, des données qu'on
 * détruit ou qu'on remplace.
 *
 * C'est la liste qui décide, quand l'instance l'exige, qui doit porter un
 * second facteur : un rôle qui en porte une seule y est soumis. Déployer en
 * fait partie — déployer ce qu'on veut, c'est exécuter ce qu'on veut sur la
 * machine.
 */
export const SENSITIVE_PERMISSIONS: readonly Permission[] = [
  // comptes et rôles
  'user:manage',
  'user:reset-2fa',
  'role:manage',
  // l'instance
  'settings:manage',
  // les machines
  'target:create',
  'target:update',
  'target:delete',
  'workload:manage',
  'workload:exec',
  // du code exécuté sur une machine
  'application:create',
  'application:update',
  'deployment:create',
  // des données détruites ou remplacées
  'application:delete',
  'backup:restore',
  'deployment:destroy',
  'deployment:purge',
];

const SENSITIVE_SET: ReadonlySet<string> = new Set<string>(SENSITIVE_PERMISSIONS);

export function isSensitivePermission(permission: string): boolean {
  return SENSITIVE_SET.has(permission);
}

/** Quand l'instance exige un second facteur. */
export const TWO_FACTOR_POLICIES = ['off', 'sensitive', 'all'] as const;
export type TwoFactorPolicy = (typeof TWO_FACTOR_POLICIES)[number];

/**
 * Ce compte doit-il porter un second facteur ? Selon la politique de
 * l'instance et les permissions qu'il tient : `sensitive` y soumet tout rôle
 * qui en porte une seule sensible — l'administrateur toujours.
 */
export function requiresTwoFactor(
  permissions: readonly string[],
  policy: TwoFactorPolicy,
): boolean {
  if (policy === 'all') return true;
  if (policy === 'off') return false;
  return permissions.some(isSensitivePermission);
}

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
