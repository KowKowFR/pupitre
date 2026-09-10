import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { AppSpec, ScanConfig } from '@tp/core';
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
     * Santé constatée par le healthcheck **périodique** (jalon 8), distincte du
     * `status` du déploiement : un déploiement `success` peut devenir
     * `unreachable` trois heures plus tard sans cesser d'avoir réussi. La sonde
     * périodique n'écrit que ces deux colonnes — elle ne rollback jamais.
     */
    healthStatus: healthStatusEnum('health_status').notNull().default('unknown'),
    lastHealthAt: timestamp('last_health_at', { withTimezone: true }),
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
