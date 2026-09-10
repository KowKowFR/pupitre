import type { AppSpec, PreflightReport, RuntimesAvailable } from '@tp/core';
import { EMPTY_RUNTIMES } from '@tp/core';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sshAuthMethodEnum, sudoMethodEnum, targetStatusEnum } from '../enums.js';
import { users } from './auth.js';

export type RuntimeKey = 'docker' | 'k3s';

/** Étiquettes libres posées par l'opérateur, ex. `env=prod`, `zone=eu-west`. */
export type TargetLabels = Record<string, string>;

/** Machine distante sur laquelle le control plane déploie. */
export const targets = pgTable(
  'targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull().unique(),
    host: text('host').notNull(),
    port: integer('port').notNull().default(22),
    sshUser: text('ssh_user').notNull(),
    authMethod: sshAuthMethodEnum('auth_method').notNull(),
    sudoMethod: sudoMethodEnum('sudo_method').notNull().default('nopasswd'),
    /**
     * AES-256-GCM sous `MASTER_KEY`, format `version:iv:authTag:ciphertext`.
     * Jamais renvoyé par l'API, jamais journalisé. Déchiffré uniquement par le
     * worker, au moment d'ouvrir la session SSH.
     */
    encryptedCredential: text('encrypted_credential').notNull(),
    labels: jsonb('labels').$type<TargetLabels>().notNull().default({}),
    /** Résultat structuré du dernier preflight : versions comprises. */
    runtimesAvailable: jsonb('runtimes_available')
      .$type<RuntimesAvailable>()
      .notNull()
      .default(EMPTY_RUNTIMES),
    /**
     * Plage de ports publiables sur cette machine.
     *
     * Par cible, et non globale : une VM derrière un pare-feu n'ouvre souvent
     * qu'une poignée de ports, et deux cibles n'ont aucune raison d'avoir la
     * même politique. Le défaut reprend la plage `nodePort` de Kubernetes,
     * inoccupée sur une machine standard.
     */
    portRangeStart: integer('port_range_start').notNull().default(30_000),
    portRangeEnd: integer('port_range_end').notNull().default(32_767),
    preflightReport: jsonb('preflight_report').$type<PreflightReport | null>(),
    lastPreflightAt: timestamp('last_preflight_at', { withTimezone: true }),
    status: targetStatusEnum('status').notNull().default('unknown'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('targets_host_port_user_idx').on(t.host, t.port, t.sshUser),
    // Une plage inversée rendrait toute allocation impossible sans rien dire.
    // C'est la base qui refuse, pas une validation qu'on pourrait contourner
    // en écrivant directement en SQL.
    check('targets_port_range_check', sql`${t.portRangeStart} <= ${t.portRangeEnd}`),
  ],
);

/** Application décrite par une AppSpec neutre, indépendante du runtime. */
export const applications = pgTable(
  'applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),
    appSpec: jsonb('app_spec').$type<AppSpec>().notNull(),
    /**
     * Trace de la génération par IA, quand l'application en vient.
     *
     * `generation_prompt` est la demande de l'utilisateur, mot pour mot, et
     * `generated_app_spec` la spec telle que le modèle l'a produite — avant
     * toute retouche dans l'éditeur. `app_spec` porte, elle, ce qui a été
     * *validé* : les deux diffèrent dès que quelqu'un corrige une image ou un
     * dimensionnement, et c'est exactement ce que l'on veut pouvoir relire.
     */
    generationPrompt: text('generation_prompt'),
    generationModel: text('generation_model'),
    generatedAppSpec: jsonb('generated_app_spec').$type<AppSpec>(),
    generatedAt: timestamp('generated_at', { withTimezone: true }),
    ownerId: text('owner_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('applications_owner_id_idx').on(t.ownerId)],
);
