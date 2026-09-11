import type { ChannelConfig, NotificationEventKey } from '@tp/core';
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { notificationChannelKindEnum } from '../enums.js';
import { users } from './auth.js';

/**
 * Un moyen de prévenir quelqu'un, configuré par un opérateur.
 *
 * ── Pourquoi une table et non le JSONB des paramètres d'instance ────────────
 * `app_settings.value` est un excellent endroit pour un réglage : il en accepte
 * un de plus sans migration. Il est en revanche le mauvais endroit pour ceci,
 * pour trois raisons qui tiennent toutes à la nature de l'objet :
 *
 *   1. Il y en a **plusieurs**, créés et supprimés à la demande. Un tableau
 *      dans un JSONB n'a ni identité stable, ni unicité de nom, ni clé
 *      étrangère vers l'auteur : trois garanties qu'on réécrirait en TypeScript,
 *      c'est-à-dire qu'on n'aurait pas.
 *   2. Ils portent des **secrets**. Le fichier de projet est formel : un secret
 *      ne va jamais dans le JSONB des paramètres — la clé d'API de l'IA suit
 *      déjà cette règle avec sa colonne chiffrée dédiée. Séparer secrets et
 *      configuration aurait donc voulu dire les répartir entre deux endroits
 *      appariés à la main.
 *   3. Ils portent un **état d'exécution** qui change tout seul : dernier
 *      succès, dernier échec, échecs consécutifs. Écrire cet état à chaque
 *      envoi réécrirait le JSONB entier des paramètres d'instance — donc
 *      entrerait en concurrence avec l'écran des réglages, pour une donnée qui
 *      n'est pas un réglage.
 */
export const notificationChannels = pgTable(
  'notification_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: notificationChannelKindEnum('kind').notNull(),
    /** Comment l'opérateur l'appelle : « astreinte », « salon #ops ». Unique. */
    name: text('name').notNull().unique(),
    /**
     * Un canal éteint est conservé avec sa configuration. Couper une
     * intégration bruyante ne doit pas obliger à ressaisir un jeton pour la
     * rallumer.
     */
    enabled: boolean('enabled').notNull().default(true),
    /** Champs **non secrets** du canal, tels que le catalogue les décrit. */
    config: jsonb('config').$type<ChannelConfig>().notNull().default({}),
    /**
     * Les champs secrets, sérialisés en JSON puis chiffrés en un seul bloc.
     * AES-256-GCM sous `MASTER_KEY`, format `version:iv:authTag:ciphertext` —
     * même motif que `targets.encrypted_credential` et
     * `app_settings.ai_api_key_encrypted`.
     *
     * Colonne dédiée et non un champ de `config` : c'est ce qui permet de
     * sérialiser `config` dans une réponse d'API ou une entrée d'audit sans
     * risque, précisément parce que le secret n'y est pas.
     */
    encryptedSecrets: text('encrypted_secrets'),
    /**
     * Les événements auxquels ce canal est abonné. Un tableau JSONB plutôt
     * qu'une table de liaison : la liste est courte, toujours lue en entier, et
     * jamais interrogée dans l'autre sens.
     */
    events: jsonb('events').$type<NotificationEventKey[]>().notNull().default([]),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    /** Message du dernier échec, **déjà expurgé** de tout ce qui ressemble à un secret. */
    lastError: text('last_error'),
    /**
     * Échecs d'affilée. Remis à zéro par le premier succès. C'est ce qui
     * distingue « le serveur a hoqueté » de « ce canal ne marche plus depuis
     * trois semaines », et l'écran le dit.
     */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** `text` et non `uuid` : `users.id` est un identifiant Better Auth. */
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [index('notification_channels_enabled_idx').on(t.enabled)],
);
