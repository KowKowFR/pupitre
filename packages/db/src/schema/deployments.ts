import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { AppSpec, ScanConfig } from '@pupitre/core';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  deploymentStatusEnum,
  healthStatusEnum,
  proxyEnum,
  runtimeEnum,
  stepStatusEnum,
} from '../enums.js';
import { users } from './auth.js';
import { applications, targets } from './infra.js';

export const deployments = pgTable(
  'deployments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Numéro de run, global à l'instance : `#129` désigne un seul run, quelle
     * que soit l'application. C'est lui qu'on se dit à voix haute et qu'on
     * tape dans une recherche.
     *
     * À ne pas confondre avec `version`, qui compte les déploiements **d'une**
     * application et sert de repère au rollback. Une séquence Postgres et non
     * un `max() + 1` : deux déploiements lancés au même instant ne peuvent pas
     * recevoir le même numéro. Un numéro purgé n'est jamais réattribué.
     */
    number: integer('number').notNull().generatedByDefaultAsIdentity(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'restrict' }),
    runtime: runtimeEnum('runtime').notNull(),
    proxy: proxyEnum('proxy').notNull().default('traefik'),
    status: deploymentStatusEnum('status').notNull().default('pending'),
    /** Numéro de version incrémental par application. */
    version: integer('version').notNull().default(1),
    imageTag: text('image_tag'),
    url: text('url'),
    /**
     * AppSpec figée au moment du déploiement. `applications.app_spec` peut
     * changer ensuite : un déploiement doit rester relisible tel qu'il a été
     * exécuté, et un rollback doit repartir de la bonne version.
     */
    appSpec: jsonb('app_spec').$type<AppSpec>(),
    /**
     * Scanners retenus et seuil de blocage, figés au déploiement comme
     * l'AppSpec. Le gate est une donnée, jamais un `if` codé en dur.
     */
    scanConfig: jsonb('scan_config').$type<ScanConfig>(),
    publishedPort: integer('published_port'),
    /** Étape sur laquelle le pipeline s'est arrêté, le cas échéant. */
    failedStep: text('failed_step'),
    /**
     * Politique de rollback, figée au déploiement comme l'AppSpec et la
     * configuration de scan. Un healthcheck raté déclenche alors le retour à
     * `previous_deployment_id`, sans intervention.
     *
     * C'est une donnée et non un réglage global : la même application peut
     * mériter un rollback automatique en production et un arrêt sur échec en
     * recette, où l'on veut justement inspecter les dégâts.
     */
    autoRollback: boolean('auto_rollback').notNull().default(true),
    /** Déploiement vers lequel un rollback ramène. */
    previousDeploymentId: uuid('previous_deployment_id').references(
      (): AnyPgColumn => deployments.id,
      { onDelete: 'set null' },
    ),
    /**
     * Santé constatée par le healthcheck **périodique**, distincte du
     * `status` du déploiement : un déploiement `success` peut devenir
     * `unreachable` trois heures plus tard sans cesser d'avoir réussi. La sonde
     * périodique n'écrit que ces deux colonnes — elle ne rollback jamais.
     */
    healthStatus: healthStatusEnum('health_status').notNull().default('unknown'),
    lastHealthAt: timestamp('last_health_at', { withTimezone: true }),
    /**
     * Depuis quand cette application est **volontairement** arrêtée. `null` :
     * elle est censée tourner.
     *
     * ── Pourquoi une colonne, et pas une valeur `stopped` dans le statut ────
     * Parce que `status` raconte **l'issue d'un déploiement** — a-t-il abouti,
     * échoué, été replié, détruit — et qu'un arrêt n'est pas une issue : le
     * déploiement a réussi, et il a toujours réussi une heure après qu'on a
     * coupé les conteneurs. Écraser `success` par `stopped` perdrait cette
     * information, et le jour du redémarrage il faudrait deviner vers quoi
     * revenir.
     *
     * La conséquence pratique confirme la théorie : `status` gouverne
     * `isSupervisable()`, donc l'accès aux logs et au redémarrage. Une valeur
     * de plus rendrait muette la console d'une application arrêtée — c'est-à-
     * dire au moment précis où l'on veut lire les dernières lignes pour savoir
     * pourquoi on l'a arrêtée.
     *
     * Un horodatage plutôt qu'un booléen : « arrêtée depuis mardi » est ce que
     * l'écran a besoin de dire, et un booléen ne l'aurait jamais su.
     */
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
    triggeredBy: text('triggered_by').references(() => users.id, { onDelete: 'set null' }),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('deployments_application_id_idx').on(t.applicationId),
    index('deployments_target_id_idx').on(t.targetId),
    index('deployments_status_idx').on(t.status),
    uniqueIndex('deployments_application_version_idx').on(t.applicationId, t.version),
    uniqueIndex('deployments_number_idx').on(t.number),
  ],
);

/** Machine à états visible dans l'UI : une ligne par étape du pipeline. */
export const deploymentSteps = pgTable(
  'deployment_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => deployments.id, { onDelete: 'cascade' }),
    order: integer('order').notNull(),
    /** Identifiant stable de l'étape, ex. `render`, `upload`, `compose_up`. */
    key: text('key').notNull(),
    label: text('label').notNull(),
    status: stepStatusEnum('status').notNull().default('pending'),
    error: text('error'),
    /**
     * Journal de l'étape, en append. Doublonne le canal Redis à dessein :
     * Redis diffuse le direct, cette colonne permet la relecture après coup.
     */
    log: text('log').notNull().default(''),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('deployment_steps_deployment_order_idx').on(t.deploymentId, t.order),
    index('deployment_steps_deployment_id_idx').on(t.deploymentId),
  ],
);

/**
 * Anti-collision de ports. La garantie est la contrainte unique
 * `(target_id, port)` — jamais un `if` en TypeScript.
 */
export const portAllocations = pgTable(
  'port_allocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    port: integer('port').notNull(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('port_allocations_target_port_idx').on(t.targetId, t.port),
    index('port_allocations_application_id_idx').on(t.applicationId),
  ],
);
