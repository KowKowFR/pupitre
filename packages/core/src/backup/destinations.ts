import { z } from 'zod';
import { invalid } from '../validation.js';

/**
 * Où vont les sauvegardes. Hors de la machine du panel, par principe : une
 * sauvegarde rangée à côté de ce qu'elle protège disparaît avec lui.
 *
 *   - `s3`    tout stockage compatible S3 : AWS, Scaleway, Backblaze B2,
 *             Wasabi, un MinIO sur un NAS ;
 *   - `sftp`  un NAS (Synology, QNAP, TrueNAS) ou n'importe quel serveur SSH ;
 *   - `local` un dossier monté dans le conteneur du worker — un partage NFS
 *             ou SMB du NAS, monté sur l'hôte.
 *
 * Ce module ne décrit que les **réglages** : il sert au formulaire comme au
 * worker. Les classes qui parlent à chaque destination vivent sous
 * `@pupitre/core/backup`, et en ajouter une revient à ajouter une classe.
 *
 * Les identifiants — clés d'accès, mot de passe, clé privée — sont séparés du
 * reste : ils sont chiffrés en base sous `MASTER_KEY` et ne sont jamais rendus
 * par l'API, comme les credentials SSH des cibles.
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
  /** `https://endpoint/bucket/clé` plutôt que `https://bucket.endpoint/clé` — MinIO, NAS. */
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
   * Empreinte SHA-256 de la clé d'hôte, telle que `ssh-keygen -lf` l'écrit
   * (`SHA256:…`). Renseignée, une machine qui en présente une autre est refusée.
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
  /** Chemin **dans le conteneur du worker** — un volume monté. */
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

/** Une destination entièrement résolue — secrets déchiffrés —, pour le worker seul. */
export type ResolvedBackupDestination =
  | { kind: 's3'; config: S3DestinationConfig; secrets: S3DestinationSecrets }
  | { kind: 'sftp'; config: SftpDestinationConfig; secrets: SftpDestinationSecrets }
  | { kind: 'local'; config: LocalDestinationConfig; secrets: Record<string, never> };

/** Valide réglages et secrets d'une destination, selon son genre. */
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

/** Ce qu'un écran peut montrer d'une destination : où, jamais avec quoi. */
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
