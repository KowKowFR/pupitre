import 'server-only';
import { assertMasterKey } from '@pupitre/core';
import { z } from 'zod';

/** Dans un `.env`, une variable déclarée mais vide vaut « non renseignée ». */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const booleanish = z
  .preprocess(
    (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
    z.enum(['true', '1', 'yes', 'false', '0', 'no', '']).default('false'),
  )
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  /** Validée en profondeur par `assertMasterKey()` : hex 32 octets ou passphrase ≥ 32 octets. */
  // i18n-ignore — refus au démarrage, lu dans la console par un opérateur.
  // Aucune session, aucune base : la langue de l'instance n'existe pas encore.
  MASTER_KEY: z.string().min(32, 'MASTER_KEY doit faire au moins 32 octets'),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url().default('http://localhost:3000'),
  /**
   * Inscription publique. Toujours autorisée tant qu'aucun utilisateur n'existe,
   * afin de pouvoir créer le premier administrateur.
   */
  ALLOW_SIGNUP: booleanish,
  OPENROUTER_API_KEY: optional(z.string().min(1)),
  /**
   * Modèle OpenRouter. Vide = le défaut de `@pupitre/core/ai`, choisi pour sa
   * fiabilité en sortie structurée.
   */
  OPENROUTER_MODEL: optional(z.string().min(1)),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /**
   * Plages internes que les sondes de supervision ont le droit d'atteindre, en
   * CIDR séparés par des virgules. Vide = adresses publiques uniquement.
   *
   * Le panel la lit pour **refuser une URL à la création**, avec un message
   * utile ; le worker la relit pour refuser à chaque saut de redirection. Les
   * deux doivent porter la même valeur — c'est le `.env` partagé qui l'assure.
   */
  MONITOR_ALLOWED_CIDRS: z.string().default(''),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/**
 * Validation paresseuse : au premier accès à l'exécution, jamais à l'import.
 * `next build` ne doit pas exiger un environnement complet.
 */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = JSON.stringify(z.flattenError(parsed.error).fieldErrors);
    throw new Error(`Configuration invalide : ${details}`);
  }
  // Refuse de servir avec une MASTER_KEY inutilisable.
  const weakKey = assertMasterKey();
  if (weakKey) {
    // `getEnv()` est mise en cache : cet avertissement ne sort donc qu'une fois
    // par processus, au premier appel — pas à chaque requête.
    console.warn(
      `[panel] ${weakKey} — MASTER_KEY est la valeur d'exemple ou une valeur ` +
        'devinable. Les identifiants SSH chiffrés en base ne sont pas protégés. ' +
        'Générer : openssl rand -hex 32, puis rechiffrer les cibles.',
    );
  }
  cached = parsed.data;
  return cached;
}
