import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  /** Validated in depth by `assertMasterKey()` at startup. */
  MASTER_KEY: z.string().min(32, 'MASTER_KEY must be at least 32 bytes'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  /** Simultaneous log viewers. Each holds an SSH session open. */
  SUPERVISION_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
  WORKER_ID: z.string().min(1).default('worker-1'),
  /**
   * Internal ranges the monitoring probes are allowed to reach, as comma-separated
   * CIDRs — e.g. `10.0.0.0/8,192.168.1.0/24`.
   *
   * Empty by default: only **public** addresses can be probed. It is the SSRF
   * guard, and it is lifted here and nowhere else — not from the interface, not
   * with a permission. The complete reasoning is in
   * `packages/core/src/monitoring.ts`.
   *
   * Link-local (`169.254.0.0/16`, which carries the metadata services), multicast
   * and reserved stay refused even if they are listed here.
   */
  MONITOR_ALLOWED_CIDRS: z.string().default(''),
  /**
   * CDP endpoint of the capture browser — `http://capture-browser:9222`.
   *
   * **Empty by default, and it is the feature's switch.** Without this variable,
   * no capture is attempted, no egress proxy is opened, and nothing fails: an
   * instance that wants no captures does not start a browser and does not pay its
   * price. The container lives behind the `capture` Compose profile, like
   * `mailpit` and `ssh-target`.
   *
   * ⚠ A capture shows the page as an anonymous visitor sees it. The browser
   * carries no session — a new context each time — but a monitored URL that itself
   * carries a token (`?token=…`) will make private content appear in the image.
   * Images are only served to `monitor:read` and go out in no alert; the complete
   * reasoning is in `packages/core/src/monitors/capture.ts`.
   */
  MONITOR_CAPTURE_CDP_URL: z.string().default(''),
  /**
   * Port of the browser's egress proxy, opened by the worker and only when capture
   * is active.
   *
   * The browser is locked on an **internal** Compose network: its only route leads
   * to the worker. Everything it loads therefore goes through this port, and
   * through the same SSRF guard as the probes. The reasoning — and the measurement
   * that showed a mere separate network was not enough — is in
   * `packages/core/src/capture/egress.ts`.
   */
  MONITOR_CAPTURE_EGRESS_PORT: z.coerce.number().int().min(1).max(65_535).default(8383),
  /**
   * Backups run at the same time. One by default: neither the target nor the
   * destination like ten archives at once, and the night is long.
   */
  BACKUP_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  /**
   * Where a restore places its files while verifying them, before applying them.
   * It needs room for the largest archive.
   */
  BACKUP_TMP_DIR: z.string().min(1).default('/tmp'),
  /** The PostgreSQL tools for the panel backup — in the worker's Docker image. */
  PG_DUMP_PATH: z.string().min(1).default('pg_dump'),
  PG_RESTORE_PATH: z.string().min(1).default('pg_restore'),
  /** Root where the driver places its artifacts on the targets. */
  DRIVER_ROOT_PATH: z.string().min(1).default('/opt/bootstrap'),
  /**
   * Range of publishable ports, as `min-max`. Useful when a firewall only opens
   * part of the default range (30000-32767).
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
    '[worker] invalid configuration:',
    JSON.stringify(z.flattenError(parsed.error).fieldErrors, null, 2),
  );
  process.exit(1);
}

export const env = parsed.data;
