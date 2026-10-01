import { z } from 'zod';
import { parseImageReference } from '../images/reference.js';
import type { AppSpec } from '../spec/index.js';

/**
 * Les sauvegardes — le vocabulaire, le plan, la rétention. Rien ici n'exécute :
 * le worker fait, les drivers savent comment, ce module dit **quoi**.
 *
 * ── Ce qui est sauvegardé ───────────────────────────────────────────────────
 *   - la base du panel : `pg_dump` du PostgreSQL de Pupitre ;
 *   - par application, les données déclarées par son AppSpec : les volumes,
 *     et pour une base de données reconnue, un **export logique** plutôt que la
 *     copie de ses fichiers.
 *
 * ── Pourquoi un export plutôt que les fichiers, pour une base ───────────────
 * Copier le répertoire de PostgreSQL pendant qu'il écrit, c'est photographier
 * une page en train d'être tournée : l'archive se restaure, la base refuse de
 * démarrer. L'export (`pg_dumpall`, `mysqldump`, `mongodump`) est cohérent par
 * construction, sans arrêter quoi que ce soit.
 *
 * Le mode « arrêt bref » renverse l'arbitrage : l'application est arrêtée le
 * temps de copier ses volumes — bases comprises, alors cohérentes —, puis
 * relancée. C'est la seule façon de sauvegarder proprement une base que le
 * panel ne reconnaît pas.
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

// ─── bases de données reconnues ──────────────────────────────────────────────

export const BACKUP_ENGINES = ['postgres', 'mysql', 'mongo'] as const;
export const backupEngineSchema = z.enum(BACKUP_ENGINES);
export type BackupEngine = z.infer<typeof backupEngineSchema>;

/**
 * Les images dont on connaît l'outil d'export **et** les variables
 * d'environnement d'administration. Une image de base qui n'est pas ici
 * (`bitnami/postgresql`, qui nomme ses variables autrement, par exemple) n'est
 * pas devinée : ses volumes sont copiés comme les autres, et l'écran conseille
 * l'arrêt bref.
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
 * Les commandes, lancées **dans** le conteneur de la base, sous `sh -c` : elles
 * lisent les identifiants dans l'environnement que l'image a déjà reçu — le
 * panel ne les manipule jamais. La sortie (export) ou l'entrée (restauration)
 * est le flux brut ; le worker compresse et chiffre de son côté.
 *
 * PostgreSQL : `pg_dumpall --clean` recrée bases, rôles et objets. Avant de
 * rejouer, les connexions de l'application sont coupées et les bases fermées
 * aux nouvelles — sans quoi `DROP DATABASE` échoue sur une base en usage.
 *
 * MySQL / MariaDB : les bases applicatives seulement — `mysql`, `sys` et les
 * schémas d'information appartiennent au serveur, les réécrire casserait ses
 * comptes. MariaDB 11 a retiré les alias `mysql*` : on prend l'outil présent.
 */
/**
 * Les arguments d'authentification MySQL, en paramètres positionnels : un mot
 * de passe vide ne doit pas devenir `-p` tout court, qui réclamerait une saisie
 * au clavier, et un mot de passe à espaces ne doit pas être coupé en deux.
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

/** La base accepte-t-elle des connexions ? Avant de lui rejouer un export. */
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

// ─── le plan d'une sauvegarde ────────────────────────────────────────────────

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
 * Ce qu'une sauvegarde de cette application contiendra, dans ce mode.
 *
 * À chaud : une base reconnue est exportée (et ses volumes ne sont **pas**
 * copiés — une copie incohérente donnerait une fausse assurance) ; les autres
 * volumes sont archivés. À l'arrêt : tous les volumes sont archivés, ils sont
 * alors cohérents, et rien n'est exporté — il n'y a plus de serveur à qui
 * demander.
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

/** Les services dont des volumes seront copiés à chaud sans être reconnus comme base. */
export function hotCopiedServices(spec: AppSpec): string[] {
  return spec.services
    .filter(
      (service) =>
        service.volumes.length > 0 &&
        !(service.source.type === 'image' && databaseEngineOf(service.source.ref)),
    )
    .map((service) => service.name);
}

/** Une application sans volume n'a rien à sauvegarder : tout est dans son AppSpec. */
export function hasBackupData(spec: AppSpec): boolean {
  return spec.services.some((service) => service.volumes.length > 0);
}

// ─── le manifeste, rangé avec les morceaux ───────────────────────────────────

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
 * Ce qu'une sauvegarde contient, rangé **avec** elle sur la destination. Une
 * destination se relit sans la base du panel : c'est précisément ce qu'on veut
 * le jour où la base est perdue.
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
  /** L'AppSpec en service au moment de la sauvegarde. */
  spec: z.unknown().nullable(),
  pieces: z.array(storedPieceSchema),
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;

export const MANIFEST_FILE = 'manifest.json.pupb';

/** Le nom d'un morceau, dans le dossier de sa sauvegarde. */
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

// ─── rétention ───────────────────────────────────────────────────────────────

export const backupRetentionSchema = z.object({
  /** Les plus récentes, quoi qu'il arrive — un avant-déploiement survit à la nuit. */
  keepLast: z.number().int().min(1).max(100).default(3),
  daily: z.number().int().min(0).max(365).default(7),
  weekly: z.number().int().min(0).max(104).default(4),
  monthly: z.number().int().min(0).max(120).default(6),
});
export type BackupRetention = z.infer<typeof backupRetentionSchema>;
export const DEFAULT_BACKUP_RETENTION: BackupRetention = backupRetentionSchema.parse({});

/** Lundi de la semaine ISO, en UTC : la clé d'un « seau » hebdomadaire. */
function weekKey(date: Date): string {
  const day = (date.getUTCDay() + 6) % 7;
  const monday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day),
  );
  return monday.toISOString().slice(0, 10);
}

/**
 * Grand-père, père, fils : on garde les `keepLast` plus récentes, puis la plus
 * récente de chacun des `daily` derniers jours, des `weekly` dernières semaines
 * et des `monthly` derniers mois. Tout le reste est rendu — seulement des
 * sauvegardes **réussies** : un échec n'occupe aucune place et ne protège rien.
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

// ─── politique par application ───────────────────────────────────────────────

export const backupPolicySchema = z.object({
  /** Sauvegardée par la tâche planifiée « Sauvegardes des applications ». */
  enabled: z.boolean().default(false),
  mode: backupModeSchema.default('hot'),
  /** Une sauvegarde avant chaque déploiement — mise à jour d'image comprise. */
  beforeDeploy: z.boolean().default(false),
  retention: backupRetentionSchema.default(DEFAULT_BACKUP_RETENTION),
});
export type BackupPolicy = z.infer<typeof backupPolicySchema>;
export const DEFAULT_BACKUP_POLICY: BackupPolicy = backupPolicySchema.parse({});
