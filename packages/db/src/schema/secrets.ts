import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { secretOriginEnum } from '../enums.js';
import { applications } from './infra.js';

/**
 * Magasin des valeurs de secrets.
 *
 * L'AppSpec ne déclare que des **noms** (`secrets: ["POSTGRES_PASSWORD"]`) :
 * c'est ce qui lui permet d'être lue, versionnée et régénérée par l'IA sans
 * jamais porter de valeur en clair. Les valeurs vivent ici, chiffrées, et ne
 * sont déchiffrées qu'au moment du rendu, par le worker.
 *
 * ── Pourquoi la valeur est attachée à l'APPLICATION, pas au déploiement ──────
 *
 * C'est la décision structurante de cette table, et celle qu'on ne retrouverait
 * plus six mois après.
 *
 * Un mot de passe de base de données n'est pas une propriété de la mise en
 * ligne, c'est une propriété de l'application : le volume `/var/lib/postgresql`
 * survit au déploiement qui l'a créé et porte le mot de passe du **premier**
 * démarrage. Rattacher le secret au déploiement, ou le tirer au sort à chaque
 * rendu, produirait un `.env` différent à chaque mise en ligne : PostgreSQL
 * refuserait la connexion avec le nouveau mot de passe sur l'ancien volume, et
 * l'application tomberait au deuxième déploiement — c'est-à-dire au pire moment,
 * celui où l'on croit ne rien avoir changé.
 *
 * Attachée à l'application, la valeur est **stable dans le temps** : elle est
 * créée une fois, réutilisée à chaque déploiement, sur chaque cible et sur
 * chaque runtime. Elle ne change que si quelqu'un le demande explicitement.
 *
 * ── Ce qui n'est jamais fait ────────────────────────────────────────────────
 *
 * Cette table n'est jamais lue par une route qui répond à un humain. Le seul
 * chemin de déchiffrement est `resolveApplicationSecrets()`, réservé au worker,
 * exactement comme `getTargetSecret()` pour les credentials SSH.
 */
export const applicationSecrets = pgTable(
  'application_secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** Nom déclaré par l'AppSpec : `^[A-Z_][A-Z0-9_]*$`. */
    name: text('name').notNull(),
    /**
     * AES-256-GCM sous `MASTER_KEY`, format `version:iv:authTag:ciphertext` —
     * même enveloppe que `targets.encrypted_credential`, même helper
     * (`@pupitre/core` › `encrypt()` / `decrypt()`), même règle : jamais renvoyé par
     * l'API, jamais journalisé.
     */
    encryptedValue: text('encrypted_value').notNull(),
    origin: secretOriginEnum('origin').notNull().default('generated'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Un nom, une valeur, par application. C'est la base qui l'impose : sans
    // cette contrainte, deux déploiements concurrents de la même application
    // pourraient chacun générer « leur » mot de passe, et le dernier écrit
    // gagnerait silencieusement.
    uniqueIndex('application_secrets_app_name_idx').on(t.applicationId, t.name),
    index('application_secrets_application_id_idx').on(t.applicationId),
  ],
);
