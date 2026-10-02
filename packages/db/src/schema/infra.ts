import type { AppSpec, PreflightReport, RuntimesAvailable } from '@pupitre/core';
import { EMPTY_RUNTIMES } from '@pupitre/core';
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

/**
 * Étiquettes libres posées par l'opérateur, ex. `env=prod`, `zone=eu-west`.
 *
 * Le modèle reste des paires clé/valeur, comme Kubernetes, et **ne porte pas de
 * couleur**. La couleur d'une étiquette est dérivée de son texte au rendu
 * (hachage → teinte), ce qui la rend stable partout sans rien stocker et,
 * surtout, empêche quiconque de peindre une étiquette en rouge ou en vert —
 * ces teintes-là disent l'état d'une machine dans ce panel, pas son étiquette.
 */
export type TargetLabels = Record<string, string>;

/** Machine distante sur laquelle le control plane déploie. */
export const targets = pgTable(
  'targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull().unique(),
    /**
     * À quoi sert cette machine, en une ou deux phrases.
     *
     * `NULL` et non `''` quand elle est absente : une chaîne vide se mettrait à
     * occuper une ligne dans chaque tableau, et « pas de description » n'est pas
     * « une description vide ». Le schéma Zod normalise donc `''` en `null`.
     */
    description: text('description'),
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
    /**
     * L'empreinte de la clé d'hôte retenue (`SHA256:…`), relevée au premier
     * contact — comme `known_hosts`. Une autre clé fait ensuite refuser la
     * connexion. `NULL` : machine jamais jointe, ou dont l'adresse a changé.
     */
    hostKeyFingerprint: text('host_key_fingerprint'),
    hostKeyRecordedAt: timestamp('host_key_recorded_at', { withTimezone: true }),
    /**
     * Une clé présentée qui n'était pas la retenue, en attente d'une décision :
     * l'accepter (la machine a été réinstallée) ou l'écarter.
     */
    hostKeyPending: text('host_key_pending'),
    hostKeyPendingAt: timestamp('host_key_pending_at', { withTimezone: true }),
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
    // La borne de longueur est en base, comme la plage de ports : la validation
    // Zod protège le formulaire, la contrainte protège la donnée. 280 caractères
    // tiennent en trois lignes sur une fiche et se coupent proprement à une ligne
    // dans un tableau dense ; au-delà on écrit une procédure, pas une étiquette
    // d'inventaire, et le panel n'a nulle part où la rendre correctement.
    check('targets_description_length_check', sql`char_length(${t.description}) <= 280`),
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
