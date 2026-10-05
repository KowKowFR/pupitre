import { z } from 'zod';
import { invalid } from '../validation.js';

/**
 * Where backups go. Off the panel's machine, on principle: a backup stored next
 * to what it protects disappears with it.
 *
 *   - `s3`    any S3-compatible storage: AWS, Scaleway, Backblaze B2, Wasabi, a
 *             MinIO on a NAS;
 *   - `sftp`  a NAS (Synology, QNAP, TrueNAS) or any SSH server;
 *   - `local` a folder mounted in the worker's container — an NFS or SMB share of
 *             the NAS, mounted on the host.
 *
 * This module only describes the **settings**: it serves the form as well as the
 * worker. The classes that talk to each destination live under
 * `@pupitre/core/backup`, and adding one amounts to adding a class.
 *
 * The credentials — access keys, password, private key — are kept apart from
 * the rest: they are encrypted in the database under `MASTER_KEY` and never
 * returned by the API, like the targets' SSH credentials.
 */

export const BACKUP_DESTINATION_KINDS = ['s3', 'sftp', 'local'] as const;
export const backupDestinationKindSchema = z.enum(BACKUP_DESTINATION_KINDS);
export type BackupDestinationKind = z.infer<typeof backupDestinationKindSchema>;

const relativePath = z
  .string()
  .trim()
  .max(300)
  .refine((value) => !value.split('/').includes('..'), 'chemin sans « .. »')
  .transform((value) => value.replace(/^\/+|\/+$/g, ''));

export const s3DestinationConfigSchema = z.object({
  endpoint: z
    .string()
    .trim()
    .url()
    .refine((value) => /^https?:\/\//.test(value), 'http(s) seulement'),
  region: z.string().trim().min(1).max(60).default('us-east-1'),
  bucket: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'nom de bucket S3'),
  prefix: relativePath.default(''),
  /** `https://endpoint/bucket/key` rather than `https://bucket.endpoint/key` — MinIO, NAS. */
  pathStyle: z.boolean().default(true),
});
export const s3DestinationSecretsSchema = z.object({
  accessKeyId: z.string().trim().min(1).max(200),
  secretAccessKey: z.string().min(1).max(400),
});

export const sftpDestinationConfigSchema = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.coerce.number().int().min(1).max(65_535).default(22),
  username: z.string().trim().min(1).max(100),
  path: relativePath.default('pupitre-backups'),
  /**
   * SHA-256 fingerprint of the host key, as `ssh-keygen -lf` writes it
   * (`SHA256:…`). Filled in, a machine that presents another one is refused.
   */
  fingerprint: z
    .string()
    .trim()
    .regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/, 'empreinte SHA256:…')
    .optional()
    .or(z.literal('').transform(() => undefined)),
});
export const sftpDestinationSecretsSchema = z
  .object({
    password: z.string().min(1).max(400).optional(),
    privateKey: z.string().min(1).max(16_000).optional(),
  })
  .refine((value) => Boolean(value.password || value.privateKey), invalid('backup.sftpSecret'));

export const localDestinationConfigSchema = z.object({
  /** Path **in the worker's container** — a mounted volume. */
  path: z
    .string()
    .trim()
    .regex(/^\/[^\0]*$/, 'chemin absolu')
    .refine((value) => !value.split('/').includes('..'), 'chemin sans « .. »'),
});
export const localDestinationSecretsSchema = z.object({});

export const backupDestinationSchemas = {
  s3: { config: s3DestinationConfigSchema, secrets: s3DestinationSecretsSchema },
  sftp: { config: sftpDestinationConfigSchema, secrets: sftpDestinationSecretsSchema },
  local: { config: localDestinationConfigSchema, secrets: localDestinationSecretsSchema },
} as const;

export type S3DestinationConfig = z.infer<typeof s3DestinationConfigSchema>;
export type S3DestinationSecrets = z.infer<typeof s3DestinationSecretsSchema>;
export type SftpDestinationConfig = z.infer<typeof sftpDestinationConfigSchema>;
export type SftpDestinationSecrets = z.infer<typeof sftpDestinationSecretsSchema>;
export type LocalDestinationConfig = z.infer<typeof localDestinationConfigSchema>;

/** A fully resolved destination — secrets decrypted —, for the worker alone. */
export type ResolvedBackupDestination =
  | { kind: 's3'; config: S3DestinationConfig; secrets: S3DestinationSecrets }
  | { kind: 'sftp'; config: SftpDestinationConfig; secrets: SftpDestinationSecrets }
  | { kind: 'local'; config: LocalDestinationConfig; secrets: Record<string, never> };

/** Validates a destination's settings and secrets, according to its kind. */
export function parseBackupDestination(
  kind: BackupDestinationKind,
  config: unknown,
  secrets: unknown,
): ResolvedBackupDestination {
  switch (kind) {
    case 's3':
      return {
        kind,
        config: s3DestinationConfigSchema.parse(config),
        secrets: s3DestinationSecretsSchema.parse(secrets),
      };
    case 'sftp':
      return {
        kind,
        config: sftpDestinationConfigSchema.parse(config),
        secrets: sftpDestinationSecretsSchema.parse(secrets),
      };
    case 'local':
      return { kind, config: localDestinationConfigSchema.parse(config), secrets: {} };
  }
}

/** What a screen can show of a destination: where, never with what. */
export function describeBackupDestination(destination: {
  kind: BackupDestinationKind;
  config: Record<string, unknown>;
}): string {
  const config = destination.config;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  switch (destination.kind) {
    case 's3': {
      const prefix = text(config.prefix);
      return `s3://${text(config.bucket)}${prefix ? `/${prefix}` : ''} · ${text(config.endpoint)}`;
    }
    case 'sftp':
      return `sftp://${text(config.username)}@${text(config.host)}:${String(config.port ?? 22)}/${text(config.path)}`;
    case 'local':
      return text(config.path);
  }
}
