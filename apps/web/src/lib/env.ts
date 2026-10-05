import 'server-only';
import { assertMasterKey, secretWeakness } from '@pupitre/core';
import { z } from 'zod';

/** In a `.env`, a variable declared but empty counts as "not set". */
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
  /** Validated in depth by `assertMasterKey()`: 32 hex bytes or a passphrase ≥ 32 bytes. */
  // i18n-ignore — a refusal at startup, read in the console by an operator. No
  // session, no database: the instance's language does not exist yet.
  MASTER_KEY: z.string().min(32, 'MASTER_KEY must be at least 32 bytes'),
  /** The keys MASTER_KEY replaced, comma-separated: read, never written with. */
  MASTER_KEY_PREVIOUS: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url().default('http://localhost:3000'),
  /**
   * Public sign-up. Always allowed as long as no user exists, so that the first
   * administrator can be created.
   */
  ALLOW_SIGNUP: booleanish,
  OPENROUTER_API_KEY: optional(z.string().min(1)),
  /**
   * The OpenRouter model. Empty = `@pupitre/core/ai`'s default, chosen for its
   * reliability in structured output.
   */
  OPENROUTER_MODEL: optional(z.string().min(1)),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /**
   * The internal ranges the monitoring probes are allowed to reach, as
   * comma-separated CIDRs. Empty = public addresses only.
   *
   * The panel reads it to **refuse a URL at creation**, with a useful message; the
   * worker reads it again to refuse at each redirect hop. Both must carry the same
   * value — it is the shared `.env` that ensures it.
   */
  MONITOR_ALLOWED_CIDRS: z.string().default(''),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/**
 * Lazy validation: at the first access at run time, never at import. `next build`
 * must not require a complete environment.
 */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = JSON.stringify(z.flattenError(parsed.error).fieldErrors);
    throw new Error(`Invalid configuration: ${details}`);
  }
  // Refuses to serve with an unusable MASTER_KEY.
  const weakKey = assertMasterKey();
  if (weakKey) {
    // `getEnv()` is cached: this warning therefore only comes out once per process,
    // at the first call — not at each request.
    console.warn(
      `[panel] ${weakKey} — MASTER_KEY is the example value or a guessable ` +
        'one. The SSH credentials encrypted in the database are not protected. ' +
        'Generate one: openssl rand -hex 32, move this one to MASTER_KEY_PREVIOUS, ' +
        'then run `crypto rotate --yes` (docs/security.md).',
    );
  }
  // The same judgment for Better Auth's secret: it signs the session cookies, and
  // encrypts each account's TOTP secret and backup codes. Only warn — changing it
  // signs everyone out and makes the already armed second factor unreadable, which
  // will have to be reset.
  const weakAuthSecret = secretWeakness(parsed.data.BETTER_AUTH_SECRET, 'BETTER_AUTH_SECRET');
  if (weakAuthSecret) {
    console.warn(
      `[panel] ${weakAuthSecret} — BETTER_AUTH_SECRET is the example value or a guessable ` +
        'one. Generate one: openssl rand -base64 32. Changing it signs out every account ' +
        'and requires resetting the second factor of those that have one.',
    );
  }
  cached = parsed.data;
  return cached;
}
