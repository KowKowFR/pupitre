import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  /** Validée en profondeur par `assertMasterKey()` au démarrage. */
  MASTER_KEY: z.string().min(32, 'MASTER_KEY doit faire au moins 32 octets'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  /** Spectateurs de logs simultanés. Chacun tient une session SSH ouverte. */
  SUPERVISION_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
  WORKER_ID: z.string().min(1).default('worker-1'),
  /** Racine où le driver dépose ses artefacts sur les cibles. */
  DRIVER_ROOT_PATH: z.string().min(1).default('/opt/bootstrap'),
  /**
   * Plage de ports publiables, au format `min-max`. Utile quand un pare-feu
   * n'ouvre qu'une partie de la plage par défaut (30000-32767).
   */
  DRIVER_PORT_RANGE: z
    .preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .string()
        .regex(/^\d+-\d+$/, 'format attendu : min-max')
        .optional(),
    )
    .transform((value) => {
      if (!value) return undefined;
      const [min, max] = value.split('-').map(Number);
      return { min: min ?? 30_000, max: max ?? 32_767 };
    }),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error(
    '[worker] configuration invalide :',
    JSON.stringify(z.flattenError(parsed.error).fieldErrors, null, 2),
  );
  process.exit(1);
}

export const env = parsed.data;
