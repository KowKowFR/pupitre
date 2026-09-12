import type { ChannelConfig, NotificationEventKey } from '@tp/core';
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
  uuid,
} from 'drizzle-orm/pg-core';
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

/**
 * Le réglage du regroupement — une ligne, deux colonnes utiles.
 *
 * ── Pourquoi pas `app_settings` ─────────────────────────────────────────────
 * Ce serait l'endroit naturel : un scalaire de plus dans le JSONB, sans
 * migration. Deux raisons de ne pas y aller. D'abord `app_settings.value` est
 * réécrit en entier à chaque enregistrement de l'écran des paramètres, et cette
 * valeur est lue **à chaque événement notifiable** — c'est une donnée du chemin
 * chaud des notifications, pas un préréglage d'instance. Ensuite, le schéma des
 * paramètres est la source unique de vérité d'un autre chantier ; y ajouter un
 * champ pour une raison qui lui est étrangère, c'est le faire grossir par
 * accident. La table des canaux avait été sortie du JSONB pour des motifs
 * voisins, et le raisonnement tient ici aussi.
 *
 * ── Pourquoi le réglage existe ──────────────────────────────────────────────
 * Cinq minutes conviennent à une instance qui déploie dix fois par jour ; elles
 * sont trop longues pour une astreinte qui veut voir la vague en direct, trop
 * courtes pour une flotte bruyante. Le réglage est **borné** :
 * `NOTIFICATION_DIGEST_WINDOW_MS_MIN` interdit de le ramener à zéro. Un
 * garde-fou de volume désactivable est un garde-fou désactivé.
 */
export const notificationPolicy = pgTable(
  'notification_policy',
  {
    /** Ligne unique. La contrainte est portée par la base, pas par une convention. */
    id: integer('id').primaryKey().default(1),
    /** Fenêtre de base, en millisecondes. Elle double à chaque orage qui dure. */
    windowMs: integer('window_ms').notNull().default(300_000),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [check('notification_policy_single_row', sql`${t.id} = 1`)],
);

/**
 * L'état de regroupement d'un événement — la mémoire du garde-fou de volume.
 *
 * ── Pourquoi en base et pas en mémoire du worker ────────────────────────────
 * Parce qu'un redémarrage du worker au milieu d'un orage relâcherait tout d'un
 * coup : la fenêtre ouverte disparaîtrait, chaque événement suivant repartirait
 * « immédiat », et le regroupement aurait produit exactement le comportement
 * qu'il devait empêcher — en pire, puisqu'il aurait aussi perdu les événements
 * déjà retenus. L'état vit donc là où il survit à tout : la fenêtre en cours
 * ici, les événements retenus dans la table sœur.
 *
 * ── Pourquoi pas Redis ──────────────────────────────────────────────────────
 * Redis porte déjà l'anti-doublon des tâches, et c'est le bon endroit pour une
 * information dont la perte est bénigne (au pire, un message en double). Ici la
 * perte n'est pas bénigne : elle perd des alertes retenues. Une table, une
 * transaction, une clé primaire — et l'atomicité de la décision « immédiat ou
 * retenu » est celle de Postgres, pas d'un verrou applicatif.
 */
export const notificationDigestGroups = pgTable('notification_digest_groups', {
  /**
   * La clé de regroupement, aujourd'hui l'événement lui-même
   * (`notificationDigestGroupKey()`). Du `text` et non l'énumération des
   * événements : la granularité de la clé est une décision de `@tp/core`, et
   * l'affiner un jour ne doit pas coûter une migration.
   */
  groupKey: text('group_key').primaryKey(),
  event: text('event').notNull(),
  /**
   * Fin de la fenêtre ouverte. **`null` est l'état silencieux** : aucun orage en
   * cours, la prochaine alerte part sans délai. C'est la colonne qui porte tout
   * l'arbitrage — vide, on prévient vite ; pleine, on prévient peu.
   */
  windowEndsAt: timestamp('window_ends_at', { withTimezone: true }),
  windowStartedAt: timestamp('window_started_at', { withTimezone: true }),
  /** Durée de la fenêtre en cours. Elle double à chaque fermeture non vide. */
  windowMs: integer('window_ms').notNull().default(300_000),
  /** Fermetures non vides d'affilée, bornées. C'est le « seuil de débit », auto-réglé. */
  escalation: integer('escalation').notNull().default(0),
  /**
   * Événements retenus depuis l'ouverture. Compte **au-delà** du nombre de
   * lignes conservées : c'est lui qui permet au résumé de dire « 500 alertes,
   * 100 nommées », plutôt que de mentir par omission.
   */
  heldCount: integer('held_count').notNull().default(0),
  firstHeldAt: timestamp('first_held_at', { withTimezone: true }),
  lastHeldAt: timestamp('last_held_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Un événement retenu, déjà réduit à la ligne qu'il occupera dans le résumé.
 *
 * On ne recopie **pas** la charge utile d'audit : elle est volumineuse, sa forme
 * n'est garantie par rien, et la ligne est parfaitement calculable au moment où
 * l'événement arrive — l'acteur est résolu, le contexte est frais. Ce qui est
 * stocké est donc exactement ce qui sera lu, ni plus, ni moins.
 */
export const notificationDigestItems = pgTable(
  'notification_digest_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupKey: text('group_key')
      .notNull()
      .references(() => notificationDigestGroups.groupKey, { onDelete: 'cascade' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /** Ce que la ligne nomme : « déploiement 4f2a… », « compte alice@… ». */
    label: text('label').notNull(),
    detail: text('detail'),
    url: text('url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notification_digest_items_group_idx').on(t.groupKey, t.occurredAt)],
);
