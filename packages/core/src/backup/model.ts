import { z } from 'zod';
import { parseImageReference } from '../images/reference.js';
import type { AppSpec } from '../spec/index.js';

/**
 * Backups — the vocabulary, the plan, the retention. Nothing here runs: the
 * worker does, the drivers know how, this module says **what**.
 *
 * ── What is backed up ───────────────────────────────────────────────────────
 *   - the panel's database: `pg_dump` of Pupitre's PostgreSQL;
 *   - per application, the data declared by its AppSpec: the volumes, and for a
 *     recognized database, a **logical export** rather than a copy of its files.
 *
 * ── Why an export rather than the files, for a database ─────────────────────
 * Copying PostgreSQL's directory while it writes is photographing a page being
 * turned: the archive restores, the database refuses to start. The export
 * (`pg_dumpall`, `mysqldump`, `mongodump`) is consistent by construction,
 * without stopping anything.
 *
 * The "brief stop" mode reverses the trade-off: the application is stopped
 * while its volumes are copied — databases included, then consistent —, then
 * restarted. It is the only way to cleanly back up a database the panel does not
 * recognize.
 */

export const BACKUP_MODES = ['hot', 'stop'] as const;
export const backupModeSchema = z.enum(BACKUP_MODES);
export type BackupMode = z.infer<typeof backupModeSchema>;

export const BACKUP_TRIGGERS = ['schedule', 'manual', 'pre_deploy', 'pre_restore'] as const;
export const backupTriggerSchema = z.enum(BACKUP_TRIGGERS);
export type BackupTrigger = z.infer<typeof backupTriggerSchema>;

export const BACKUP_STATUSES = ['running', 'success', 'failed'] as const;
export const backupStatusSchema = z.enum(BACKUP_STATUSES);
export type BackupStatus = z.infer<typeof backupStatusSchema>;

export const BACKUP_KINDS = ['application', 'panel'] as const;
export const backupKindSchema = z.enum(BACKUP_KINDS);
export type BackupKind = z.infer<typeof backupKindSchema>;

// ─── recognized databases ────────────────────────────────────────────────────

export const BACKUP_ENGINES = ['postgres', 'mysql', 'mongo'] as const;
export const backupEngineSchema = z.enum(BACKUP_ENGINES);
export type BackupEngine = z.infer<typeof backupEngineSchema>;

/**
 * The images whose export tool **and** administration environment variables we
 * know. A database image that is not here (`bitnami/postgresql`, which names its
 * variables differently, for example) is not guessed: its volumes are copied
 * like the others, and the screen advises the brief stop.
 */
const ENGINE_REPOSITORIES: Record<string, BackupEngine> = {
  'library/postgres': 'postgres',
  'postgis/postgis': 'postgres',
  'pgvector/pgvector': 'postgres',
  'timescale/timescaledb': 'postgres',
  'timescale/timescaledb-ha': 'postgres',
  'library/mysql': 'mysql',
  'library/mariadb': 'mysql',
  'library/mongo': 'mongo',
};

export function databaseEngineOf(image: string): BackupEngine | null {
  const ref = parseImageReference(image);
  if (!ref || ref.registry !== 'registry-1.docker.io') return null;
  return ENGINE_REPOSITORIES[ref.repository] ?? null;
}

/**
 * The commands, run **inside** the database's container, under `sh -c`: they
 * read the credentials from the environment the image already received — the
 * panel never handles them. The output (export) or the input (restore) is the
 * raw stream; the worker compresses and encrypts on its side.
 *
 * PostgreSQL: `pg_dumpall --clean` recreates databases, roles and objects.
 * Before replaying, the application's connections are cut and the databases
 * closed to new ones — otherwise `DROP DATABASE` fails on a database in use.
 *
 * MySQL / MariaDB: the application databases only — `mysql`, `sys` and the
 * information schemas belong to the server, rewriting them would break its
 * accounts. MariaDB 11 removed the `mysql*` aliases: we take the tool present.
 */
/**
 * MySQL authentication arguments, as positional parameters: an empty password
 * must not become a bare `-p`, which would ask for keyboard input, and a
 * password with spaces must not be cut in two.
 */
const MYSQL_AUTH =
  'PW="${MARIADB_ROOT_PASSWORD:-${MYSQL_ROOT_PASSWORD:-}}"; set -- -uroot; ' +
  '[ -n "$PW" ] && set -- "$@" "-p$PW"; ' +
  'CLI=$(command -v mariadb || command -v mysql)';

const DUMP_COMMANDS: Record<BackupEngine, string> = {
  postgres:
    'export PGPASSWORD="${POSTGRES_PASSWORD:-}"; ' +
    'pg_dumpall --clean --if-exists -U "${POSTGRES_USER:-postgres}"',
  mysql:
    `${MYSQL_AUTH}; ` +
    'DUMP=$(command -v mariadb-dump || command -v mysqldump); ' +
    'DBS=$("$CLI" "$@" -N -e "SHOW DATABASES" | ' +
    "grep -Ev '^(mysql|sys|information_schema|performance_schema)$' | tr '\\n' ' '); " +
    'if [ -z "$DBS" ]; then echo "-- aucune base applicative"; exit 0; fi; ' +
    '"$DUMP" "$@" --single-transaction --routines --events --triggers ' +
    '--add-drop-database --databases $DBS',
  mongo:
    'if [ -n "${MONGO_INITDB_ROOT_USERNAME:-}" ]; then ' +
    'mongodump --quiet --archive --username "$MONGO_INITDB_ROOT_USERNAME" ' +
    '--password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin; ' +
    'else mongodump --quiet --archive; fi',
};

const RESTORE_COMMANDS: Record<BackupEngine, string> = {
  postgres:
    'export PGPASSWORD="${POSTGRES_PASSWORD:-}"; U="${POSTGRES_USER:-postgres}"; ' +
    'psql -q -U "$U" -d postgres -c "UPDATE pg_database SET datallowconn = false ' +
    "WHERE datname <> 'postgres' AND NOT datistemplate; " +
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity ' +
    'WHERE pid <> pg_backend_pid() AND datname IS NOT NULL;" >/dev/null && ' +
    'psql -q -X -U "$U" -d postgres >/dev/null; STATUS=$?; ' +
    'psql -q -U "$U" -d postgres -c "UPDATE pg_database SET datallowconn = true ' +
    "WHERE NOT datistemplate OR datname = 'template1';\" >/dev/null; exit $STATUS",
  mysql: `${MYSQL_AUTH}; "$CLI" "$@"`,
  mongo:
    'if [ -n "${MONGO_INITDB_ROOT_USERNAME:-}" ]; then ' +
    'mongorestore --quiet --archive --drop --username "$MONGO_INITDB_ROOT_USERNAME" ' +
    '--password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin; ' +
    'else mongorestore --quiet --archive --drop; fi',
};

/** Does the database accept connections? Before replaying an export into it. */
const READY_COMMANDS: Record<BackupEngine, string> = {
  postgres: 'pg_isready -q -U "${POSTGRES_USER:-postgres}"',
  mysql: `${MYSQL_AUTH}; "$CLI" "$@" -e "SELECT 1" >/dev/null`,
  mongo:
    'if [ -n "${MONGO_INITDB_ROOT_USERNAME:-}" ]; then ' +
    'mongosh --quiet --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" ' +
    '--authenticationDatabase admin --eval "db.runCommand({ ping: 1 })" >/dev/null; ' +
    'else mongosh --quiet --eval "db.runCommand({ ping: 1 })" >/dev/null; fi',
};

export function readyCommand(engine: BackupEngine): string {
  return READY_COMMANDS[engine];
}

export function dumpCommand(engine: BackupEngine): string {
  return DUMP_COMMANDS[engine];
}

export function restoreCommand(engine: BackupEngine): string {
  return RESTORE_COMMANDS[engine];
}

// ─── a backup's plan ─────────────────────────────────────────────────────────

export const backupPieceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('volume'),
    service: z.string(),
    volume: z.string(),
    mountPath: z.string(),
  }),
  z.object({ kind: z.literal('dump'), service: z.string(), engine: backupEngineSchema }),
]);
export type BackupPiece = z.infer<typeof backupPieceSchema>;

/**
 * What a backup of this application will contain, in this mode.
 *
 * Hot: a recognized database is exported (and its volumes are **not** copied —
 * an inconsistent copy would give false assurance); the other volumes are
 * archived. Stopped: every volume is archived, they are then consistent, and
 * nothing is exported — there is no server left to ask.
 */
export function planBackup(spec: AppSpec, mode: BackupMode): BackupPiece[] {
  const pieces: BackupPiece[] = [];
  for (const service of spec.services) {
    const engine =
      mode === 'hot' && service.source.type === 'image'
        ? databaseEngineOf(service.source.ref)
        : null;
    if (engine) {
      pieces.push({ kind: 'dump', service: service.name, engine });
      continue;
    }
    for (const volume of service.volumes) {
      pieces.push({
        kind: 'volume',
        service: service.name,
        volume: volume.name,
        mountPath: volume.mountPath,
      });
    }
  }
  return pieces;
}

/** The services whose volumes will be copied hot without being recognized as a database. */
export function hotCopiedServices(spec: AppSpec): string[] {
  return spec.services
    .filter(
      (service) =>
        service.volumes.length > 0 &&
        !(service.source.type === 'image' && databaseEngineOf(service.source.ref)),
    )
    .map((service) => service.name);
}

/** An application without a volume has nothing to back up: everything is in its AppSpec. */
export function hasBackupData(spec: AppSpec): boolean {
  return spec.services.some((service) => service.volumes.length > 0);
}

// ─── the manifest, stored with the pieces ────────────────────────────────────

export const storedPieceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('volume'),
    service: z.string(),
    volume: z.string(),
    mountPath: z.string(),
    file: z.string(),
    bytes: z.number().int().nonnegative(),
    sha256: z.string(),
  }),
  z.object({
    kind: z.literal('dump'),
    service: z.string(),
    engine: backupEngineSchema,
    file: z.string(),
    bytes: z.number().int().nonnegative(),
    sha256: z.string(),
  }),
  z.object({
    kind: z.literal('database'),
    file: z.string(),
    bytes: z.number().int().nonnegative(),
    sha256: z.string(),
  }),
]);
export type StoredPiece = z.infer<typeof storedPieceSchema>;

/**
 * What a backup contains, stored **with** it on the destination. A destination
 * can be read again without the panel's database: that is precisely what we
 * want the day the database is lost.
 */
export const backupManifestSchema = z.object({
  format: z.literal(1),
  kind: backupKindSchema,
  id: z.string().uuid(),
  createdAt: z.string(),
  mode: backupModeSchema.nullable(),
  trigger: backupTriggerSchema,
  application: z.object({ id: z.string(), slug: z.string() }).nullable(),
  target: z.object({ id: z.string(), name: z.string(), runtime: z.string() }).nullable(),
  /** The AppSpec in service at the time of the backup. */
  spec: z.unknown().nullable(),
  pieces: z.array(storedPieceSchema),
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;

export const MANIFEST_FILE = 'manifest.json.pupb';

/** A piece's name, in its backup's folder. */
export function pieceFile(piece: BackupPiece): string {
  const safe = (value: string) => value.replace(/[^a-z0-9-]/gi, '_');
  return piece.kind === 'volume'
    ? `volume-${safe(piece.service)}-${safe(piece.volume)}.tar.gz.pupb`
    : `dump-${safe(piece.service)}-${piece.engine}.gz.pupb`;
}

/** `apps/blog/2026-10-01T03-00-00Z-1a2b3c4d` — triable, lisible, unique. */
export function backupFolder(kind: BackupKind, slug: string | null, id: string, at: Date): string {
  const stamp = at
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-');
  const leaf = `${stamp}-${id.slice(0, 8)}`;
  return kind === 'panel' ? `panel/${leaf}` : `apps/${slug ?? 'inconnue'}/${leaf}`;
}

// ─── retention ───────────────────────────────────────────────────────────────

export const backupRetentionSchema = z.object({
  /** The most recent ones, whatever happens — a pre-deployment backup survives the night. */
  keepLast: z.number().int().min(1).max(100).default(3),
  daily: z.number().int().min(0).max(365).default(7),
  weekly: z.number().int().min(0).max(104).default(4),
  monthly: z.number().int().min(0).max(120).default(6),
});
export type BackupRetention = z.infer<typeof backupRetentionSchema>;
export const DEFAULT_BACKUP_RETENTION: BackupRetention = backupRetentionSchema.parse({});

/** Monday of the ISO week, in UTC: the key of a weekly "bucket". */
function weekKey(date: Date): string {
  const day = (date.getUTCDay() + 6) % 7;
  const monday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day),
  );
  return monday.toISOString().slice(0, 10);
}

/**
 * Grandfather, father, son: we keep the `keepLast` most recent, then the most
 * recent of each of the last `daily` days, the last `weekly` weeks and the last
 * `monthly` months. All the rest is returned — only **successful** backups: a
 * failure takes no room and protects nothing.
 */
export function expiredBackups<T extends { id: string; createdAt: Date }>(
  backups: readonly T[],
  retention: BackupRetention,
): T[] {
  const sorted = [...backups].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const keep = new Set<string>(sorted.slice(0, retention.keepLast).map((backup) => backup.id));

  const buckets: Array<[number, (date: Date) => string]> = [
    [retention.daily, (date) => date.toISOString().slice(0, 10)],
    [retention.weekly, weekKey],
    [retention.monthly, (date) => date.toISOString().slice(0, 7)],
  ];
  for (const [count, keyOf] of buckets) {
    const seen = new Set<string>();
    for (const backup of sorted) {
      if (seen.size >= count) break;
      const key = keyOf(backup.createdAt);
      if (seen.has(key)) continue;
      seen.add(key);
      keep.add(backup.id);
    }
  }
  return sorted.filter((backup) => !keep.has(backup.id));
}

// ─── policy per application ──────────────────────────────────────────────────

export const backupPolicySchema = z.object({
  /** Backed up by the "Application backups" scheduled task. */
  enabled: z.boolean().default(false),
  mode: backupModeSchema.default('hot'),
  /** A backup before each deployment — image update included. */
  beforeDeploy: z.boolean().default(false),
  retention: backupRetentionSchema.default(DEFAULT_BACKUP_RETENTION),
});
export type BackupPolicy = z.infer<typeof backupPolicySchema>;
export const DEFAULT_BACKUP_POLICY: BackupPolicy = backupPolicySchema.parse({});
