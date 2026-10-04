import type { AppSpec, PreflightReport, RuntimesAvailable } from '@pupitre/core';
import { EMPTY_RUNTIMES } from '@pupitre/core';
import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { failOnEnum, sshAuthMethodEnum, sudoMethodEnum, targetStatusEnum } from '../enums.js';
import { users } from './auth.js';

export type RuntimeKey = 'docker' | 'k3s';

/**
 * Free labels set by the operator, e.g. `env=prod`, `zone=eu-west`.
 *
 * The model stays key/value pairs, like Kubernetes, and **carries no color**. A
 * label's color is derived from its text at render time (hash → hue), which makes
 * it stable everywhere without storing anything and, above all, prevents anyone
 * from painting a label red or green — those hues tell a machine's state in this
 * panel, not its label.
 */
export type TargetLabels = Record<string, string>;

/** Remote machine the control plane deploys onto. */
export const targets = pgTable(
  'targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull().unique(),
    /**
     * What this machine is for, in one or two sentences.
     *
     * `NULL` and not `''` when absent: an empty string would start taking a line in
     * every table, and "no description" is not "an empty description". The Zod
     * schema therefore normalizes `''` to `null`.
     */
    description: text('description'),
    host: text('host').notNull(),
    port: integer('port').notNull().default(22),
    sshUser: text('ssh_user').notNull(),
    authMethod: sshAuthMethodEnum('auth_method').notNull(),
    sudoMethod: sudoMethodEnum('sudo_method').notNull().default('nopasswd'),
    /**
     * AES-256-GCM under `MASTER_KEY`, `version:iv:authTag:ciphertext` format. Never
     * returned by the API, never logged. Decrypted only by the worker, when opening
     * the SSH session.
     */
    encryptedCredential: text('encrypted_credential').notNull(),
    /**
     * The fingerprint of the recorded host key (`SHA256:…`), noted at first contact
     * — like `known_hosts`. Another key then makes the connection be refused.
     * `NULL`: machine never reached, or whose address changed.
     */
    hostKeyFingerprint: text('host_key_fingerprint'),
    hostKeyRecordedAt: timestamp('host_key_recorded_at', { withTimezone: true }),
    /**
     * A presented key that was not the recorded one, waiting for a decision: accept
     * it (the machine was reinstalled) or dismiss it.
     */
    hostKeyPending: text('host_key_pending'),
    hostKeyPendingAt: timestamp('host_key_pending_at', { withTimezone: true }),
    /**
     * Since when Pupitre no longer reaches the machine over SSH — the first missed
     * reading of a confirmed series —, or `null`. It is the episode: it opens once,
     * closes once, and that is what makes a single alert go out.
     */
    unreachableSince: timestamp('unreachable_since', { withTimezone: true }),
    labels: jsonb('labels').$type<TargetLabels>().notNull().default({}),
    /** Structured result of the last preflight: versions included. */
    runtimesAvailable: jsonb('runtimes_available')
      .$type<RuntimesAvailable>()
      .notNull()
      .default(EMPTY_RUNTIMES),
    /**
     * Range of ports publishable on this machine.
     *
     * Per target, and not global: a VM behind a firewall often only opens a handful
     * of ports, and two targets have no reason to have the same policy. The default
     * takes Kubernetes's `nodePort` range, unused on a standard machine.
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
    // An inverted range would make any allocation impossible without saying
    // anything. It is the database that refuses, not a validation one could bypass
    // by writing directly in SQL.
    check('targets_port_range_check', sql`${t.portRangeStart} <= ${t.portRangeEnd}`),
    // The length bound is in the database, like the port range: the Zod validation
    // protects the form, the constraint protects the data. 280 characters fit in
    // three lines on a record and cut cleanly to one line in a dense table; beyond
    // that one writes a procedure, not an inventory label, and the panel has
    // nowhere to render it properly.
    check('targets_description_length_check', sql`char_length(${t.description}) <= 280`),
  ],
);

/** Application described by a neutral AppSpec, independent of the runtime. */
export const applications = pgTable(
  'applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),
    appSpec: jsonb('app_spec').$type<AppSpec>().notNull(),
    /**
     * Trace of the AI generation, when the application comes from it.
     *
     * `generation_prompt` is the user's request, word for word, and
     * `generated_app_spec` the spec as the model produced it — before any touch-up
     * in the editor. `app_spec` carries what was *approved*: the two differ as soon
     * as someone fixes an image or a sizing, and that is exactly what we want to be
     * able to read again.
     */
    generationPrompt: text('generation_prompt'),
    generationModel: text('generation_model'),
    generatedAppSpec: jsonb('generated_app_spec').$type<AppSpec>(),
    generatedAt: timestamp('generated_at', { withTimezone: true }),
    /**
     * The application's scan setting: its blocking threshold, and whether it only
     * holds for fixable vulnerabilities. `null`: like the instance.
     */
    scanFailOn: failOnEnum('scan_fail_on'),
    scanOnlyFixable: boolean('scan_only_fixable'),
    ownerId: text('owner_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('applications_owner_id_idx').on(t.ownerId)],
);
