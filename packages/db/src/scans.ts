import {
  EMPTY_SEVERITY_COUNTS,
  SCANNERS,
  failOnFromDb,
  failOnToDb,
  scannerKeySchema,
  severityFromDb,
  severitySchema,
  severityToDb,
  type DbSeverity,
  type FailOn,
  type Finding,
  type ScanKind,
  type ScanRunStatus,
  type ScanVerdict,
  type ScannerKey,
  type Severity,
  type SeverityCounts,
} from '@pupitre/core';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Database } from './client.js';
import { deployments } from './schema/deployments.js';
import { applications, targets } from './schema/infra.js';
import { findings, scanRuns } from './schema/security.js';

/**
 * Persistance des scans.
 *
 * Deux écarts de nommage hérités du schéma d'origine, absorbés ici plutôt que par une
 * migration : `findings.version` porte l'`installedVersion` du rapport, et
 * `findings.reference` son `primaryUrl`. Le reste du projet ne voit que les
 * noms du rapport normalisé.
 *
 * Le SBOM n'a pas de colonne dédiée : il *est* la sortie brute de l'outil qui
 * le produit, donc il vit dans `scan_runs.raw`. Une colonne supplémentaire
 * dupliquerait cette valeur octet pour octet, et il faudrait alors décider
 * laquelle fait foi. Le format se lit dans `SCANNERS[scanner].sbomFormat`,
 * une donnée, pas une branche.
 */

export type ScanRun = typeof scanRuns.$inferSelect;
export type FindingRow = typeof findings.$inferSelect;

/**
 * Garde-fou de taille sur `raw`. Le rapport Trivy d'une image Debian ancienne
 * dépasse allègrement le mégaoctet ; au-delà de cette borne on garde la trace
 * de la troncature plutôt que d'engorger la base.
 */
const RAW_MAX_BYTES = 8 * 1024 * 1024;

function boundRaw(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  const serialized = JSON.stringify(raw);
  if (serialized === undefined) return null;
  if (serialized.length <= RAW_MAX_BYTES) return raw;
  return {
    truncated: true,
    bytes: serialized.length,
    note: `sortie brute écartée : ${serialized.length} octets, au-delà de la limite de ${RAW_MAX_BYTES}`,
  };
}

// ─── écriture ─────────────────────────────────────────────────────────────────

export async function createScanRun(
  input: {
    deploymentId: string;
    scanner: ScannerKey;
    failOn: FailOn;
    imageRef: string;
  },
  db: Database = getDb(),
): Promise<ScanRun> {
  const [row] = await db
    .insert(scanRuns)
    .values({
      deploymentId: input.deploymentId,
      scanner: input.scanner,
      status: 'running',
      failOn: failOnToDb(input.failOn),
      verdict: 'unknown',
      imageRef: input.imageRef,
      startedAt: new Date(),
    })
    .returning();

  if (!row) throw new Error("createScanRun : l'insertion n'a rien retourné");
  return row;
}

/**
 * Clôt une exécution et enregistre ses findings, dans une seule transaction :
 * un scan à moitié écrit donnerait un verdict faux.
 */
export async function finishScanRun(
  id: string,
  outcome: {
    status: Exclude<ScanRunStatus, 'pending' | 'running'>;
    verdict: ScanVerdict;
    findings?: readonly Finding[];
    raw?: unknown;
    error?: string | null;
  },
  db: Database = getDb(),
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(scanRuns)
      .set({
        status: outcome.status,
        verdict: outcome.verdict,
        raw: boundRaw(outcome.raw ?? null),
        error: outcome.error ?? null,
        finishedAt: new Date(),
      })
      .where(eq(scanRuns.id, id));

    const rows = outcome.findings ?? [];
    if (rows.length === 0) return;

    // Deux scanners peuvent voir la même CVE deux fois sur le même paquet
    // (sources multiples) : on ne l'écrit qu'une fois par exécution.
    const seen = new Set<string>();
    const values: Array<typeof findings.$inferInsert> = [];
    for (const finding of rows) {
      const key = `${finding.cveId}|${finding.package}|${finding.installedVersion ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      values.push({
        scanRunId: id,
        cveId: finding.cveId,
        severity: severityToDb(finding.severity),
        package: finding.package,
        version: finding.installedVersion,
        fixedVersion: finding.fixedVersion,
        title: finding.title,
        reference: finding.primaryUrl,
      });
    }

    // Postgres plafonne à 65 535 paramètres liés par requête : on découpe.
    const CHUNK = 500;
    for (let index = 0; index < values.length; index += CHUNK) {
      await tx.insert(findings).values(values.slice(index, index + CHUNK));
    }
  });
}

/**
 * Efface les exécutions d'un déploiement.
 *
 * Une relance rejoue l'étape `scan` : sans cela, la page de sécurité
 * cumulerait le rapport de l'exécution précédente et celui de la nouvelle,
 * sans moyen de les distinguer.
 */
export async function clearScanRuns(
  deploymentId: string,
  db: Database = getDb(),
): Promise<number> {
  const rows = await db
    .delete(scanRuns)
    .where(eq(scanRuns.deploymentId, deploymentId))
    .returning({ id: scanRuns.id });
  return rows.length;
}

/** Marque une exécution jamais lancée (scanner non sélectionné, ou étape sautée). */
export async function skipScanRun(
  id: string,
  reason: string,
  db: Database = getDb(),
): Promise<void> {
  await db
    .update(scanRuns)
    .set({ status: 'skipped', verdict: 'unknown', error: reason, finishedAt: new Date() })
    .where(eq(scanRuns.id, id));
}

// ─── lecture ──────────────────────────────────────────────────────────────────

export type ScanRunSummary = {
  id: string;
  deploymentId: string;
  scanner: ScannerKey;
  kind: ScanKind;
  status: ScanRunStatus;
  failOn: FailOn;
  verdict: ScanVerdict;
  imageRef: string | null;
  error: string | null;
  durationMs: number | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  counts: SeverityCounts;
  total: number;
  /** Un SBOM est téléchargeable dès lors que l'exécution a réussi. */
  hasSbom: boolean;
};

function durationOf(startedAt: Date | null, finishedAt: Date | null): number | null {
  if (!startedAt || !finishedAt) return null;
  return Math.max(0, finishedAt.getTime() - startedAt.getTime());
}

function toSummary(row: ScanRun, counts: SeverityCounts): ScanRunSummary {
  const scanner = row.scanner as ScannerKey;
  const kind = SCANNERS[scanner].kind;
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);

  return {
    id: row.id,
    deploymentId: row.deploymentId,
    scanner,
    kind,
    status: row.status as ScanRunStatus,
    failOn: failOnFromDb(row.failOn),
    verdict: row.verdict as ScanVerdict,
    imageRef: row.imageRef,
    error: row.error,
    durationMs: durationOf(row.startedAt, row.finishedAt),
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    counts,
    total,
    hasSbom: kind === 'sbom' && row.status === 'success' && row.raw !== null,
  };
}

/** Compte par sévérité, pour un ensemble d'exécutions, en une requête. */
async function countsFor(
  scanRunIds: readonly string[],
  db: Database,
): Promise<Map<string, SeverityCounts>> {
  const map = new Map<string, SeverityCounts>();
  for (const id of scanRunIds) map.set(id, { ...EMPTY_SEVERITY_COUNTS });
  if (scanRunIds.length === 0) return map;

  const rows = await db
    .select({
      scanRunId: findings.scanRunId,
      severity: findings.severity,
      value: count(),
    })
    .from(findings)
    .where(inArray(findings.scanRunId, [...scanRunIds]))
    .groupBy(findings.scanRunId, findings.severity);

  for (const row of rows) {
    const counts = map.get(row.scanRunId);
    if (!counts) continue;
    counts[severityFromDb(row.severity as DbSeverity)] += row.value;
  }
  return map;
}

export async function listScanRuns(
  deploymentId: string,
  db: Database = getDb(),
): Promise<ScanRunSummary[]> {
  const rows = await db
    .select()
    .from(scanRuns)
    .where(eq(scanRuns.deploymentId, deploymentId))
    .orderBy(asc(scanRuns.scanner), asc(scanRuns.createdAt));

  const counts = await countsFor(
    rows.map((row) => row.id),
    db,
  );

  return rows.map((row) => toSummary(row, counts.get(row.id) ?? { ...EMPTY_SEVERITY_COUNTS }));
}

export async function getScanRun(
  id: string,
  db: Database = getDb(),
): Promise<(ScanRunSummary & { applicationSlug: string; targetName: string }) | null> {
  const [row] = await db
    .select({
      run: scanRuns,
      applicationSlug: applications.slug,
      targetName: targets.name,
    })
    .from(scanRuns)
    .innerJoin(deployments, eq(deployments.id, scanRuns.deploymentId))
    .innerJoin(applications, eq(applications.id, deployments.applicationId))
    .innerJoin(targets, eq(targets.id, deployments.targetId))
    .where(eq(scanRuns.id, id));

  if (!row) return null;
  const counts = await countsFor([row.run.id], db);

  return {
    ...toSummary(row.run, counts.get(row.run.id) ?? { ...EMPTY_SEVERITY_COUNTS }),
    applicationSlug: row.applicationSlug,
    targetName: row.targetName,
  };
}

/** Sortie brute d'une exécution. Pour un scanner `sbom`, c'est le document. */
export async function getScanRunRaw(
  id: string,
  db: Database = getDb(),
): Promise<{ scanner: ScannerKey; raw: unknown; imageRef: string | null } | null> {
  const [row] = await db
    .select({ scanner: scanRuns.scanner, raw: scanRuns.raw, imageRef: scanRuns.imageRef })
    .from(scanRuns)
    .where(eq(scanRuns.id, id));

  if (!row) return null;
  return { scanner: row.scanner as ScannerKey, raw: row.raw, imageRef: row.imageRef };
}

// ─── findings ─────────────────────────────────────────────────────────────────

export type FindingView = {
  id: string;
  scanRunId: string;
  cveId: string;
  severity: Severity;
  package: string;
  installedVersion: string | null;
  fixedVersion: string | null;
  title: string | null;
  primaryUrl: string | null;
};

/**
 * Tri par sévérité décroissante côté base : une page de 50 findings doit
 * commencer par les critiques, pas par ce que l'insertion a laissé en premier.
 */
const SEVERITY_WEIGHT = sql`case ${findings.severity}
  when 'critical' then 5
  when 'high' then 4
  when 'medium' then 3
  when 'low' then 2
  when 'negligible' then 1
  else 0 end`;

function toFindingView(row: FindingRow): FindingView {
  return {
    id: row.id,
    scanRunId: row.scanRunId,
    cveId: row.cveId,
    severity: severityFromDb(row.severity as DbSeverity),
    package: row.package,
    installedVersion: row.version,
    fixedVersion: row.fixedVersion,
    title: row.title,
    primaryUrl: row.reference,
  };
}

export const findingQuerySchema = z.object({
  severity: severitySchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export type FindingQuery = z.infer<typeof findingQuerySchema>;

export type FindingPage<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

/**
 * Le filtre porte sur l'échelle commune : demander `LOW` doit aussi ramener les
 * `negligible` de la base, qui sont des `LOW` du point de vue du rapport.
 */
function severityFilter(column: typeof findings.severity, severity: Severity) {
  const values: DbSeverity[] =
    severity === 'LOW' ? ['low', 'negligible'] : [severityToDb(severity)];
  return inArray(column, values);
}

export async function listFindings(
  scanRunId: string,
  query: FindingQuery,
  db: Database = getDb(),
): Promise<FindingPage<FindingView>> {
  const where = query.severity
    ? and(eq(findings.scanRunId, scanRunId), severityFilter(findings.severity, query.severity))
    : eq(findings.scanRunId, scanRunId);

  const [rows, [totalRow]] = await Promise.all([
    db
      .select()
      .from(findings)
      .where(where)
      .orderBy(desc(SEVERITY_WEIGHT), asc(findings.package), asc(findings.cveId))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ value: count() }).from(findings).where(where),
  ]);

  const total = totalRow?.value ?? 0;
  return {
    items: rows.map(toFindingView),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

// ─── vue transverse ───────────────────────────────────────────────────────────

export const globalFindingQuerySchema = z.object({
  cveId: z.string().min(1).max(200).optional(),
  severity: severitySchema.optional(),
  applicationId: z.string().uuid().optional(),
  deploymentId: z.string().uuid().optional(),
  scanner: scannerKeySchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export type GlobalFindingQuery = z.infer<typeof globalFindingQuerySchema>;

export type GlobalFindingView = FindingView & {
  scanner: ScannerKey;
  imageRef: string | null;
  deploymentId: string;
  deploymentVersion: number;
  applicationId: string;
  applicationSlug: string;
  detectedAt: Date;
};

export async function listAllFindings(
  query: GlobalFindingQuery,
  db: Database = getDb(),
): Promise<FindingPage<GlobalFindingView>> {
  const filters = [
    query.cveId ? eq(findings.cveId, query.cveId.toUpperCase()) : undefined,
    query.severity ? severityFilter(findings.severity, query.severity) : undefined,
    query.applicationId ? eq(deployments.applicationId, query.applicationId) : undefined,
    query.deploymentId ? eq(scanRuns.deploymentId, query.deploymentId) : undefined,
    query.scanner ? eq(scanRuns.scanner, query.scanner) : undefined,
  ].filter((filter) => filter !== undefined);

  const where = filters.length > 0 ? and(...filters) : undefined;

  const base = () =>
    db
      .select({
        finding: findings,
        scanner: scanRuns.scanner,
        imageRef: scanRuns.imageRef,
        deploymentId: scanRuns.deploymentId,
        deploymentVersion: deployments.version,
        applicationId: deployments.applicationId,
        applicationSlug: applications.slug,
      })
      .from(findings)
      .innerJoin(scanRuns, eq(scanRuns.id, findings.scanRunId))
      .innerJoin(deployments, eq(deployments.id, scanRuns.deploymentId))
      .innerJoin(applications, eq(applications.id, deployments.applicationId));

  const [rows, [totalRow]] = await Promise.all([
    base()
      .where(where)
      .orderBy(desc(SEVERITY_WEIGHT), desc(findings.createdAt), asc(findings.cveId))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db
      .select({ value: count() })
      .from(findings)
      .innerJoin(scanRuns, eq(scanRuns.id, findings.scanRunId))
      .innerJoin(deployments, eq(deployments.id, scanRuns.deploymentId))
      .where(where),
  ]);

  const total = totalRow?.value ?? 0;

  return {
    items: rows.map((row) => ({
      ...toFindingView(row.finding),
      scanner: row.scanner as ScannerKey,
      imageRef: row.imageRef,
      deploymentId: row.deploymentId,
      deploymentVersion: row.deploymentVersion,
      applicationId: row.applicationId,
      applicationSlug: row.applicationSlug,
      detectedAt: row.finding.createdAt,
    })),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

// ─── historique des déploiements ──────────────────────────────────────────────

export type DeploymentScanDigest = {
  scanners: ScannerKey[];
  /** `fail` dès qu'une exécution bloque, `unknown` si l'une a échoué. */
  verdict: ScanVerdict | null;
  counts: SeverityCounts;
};

/** Résumé par déploiement, pour la colonne « Scans » de l'historique. */
export async function scanDigestForDeployments(
  deploymentIds: readonly string[],
  db: Database = getDb(),
): Promise<Map<string, DeploymentScanDigest>> {
  const digest = new Map<string, DeploymentScanDigest>();
  if (deploymentIds.length === 0) return digest;

  const rows = await db
    .select()
    .from(scanRuns)
    .where(inArray(scanRuns.deploymentId, [...deploymentIds]))
    .orderBy(asc(scanRuns.scanner));

  const counts = await countsFor(
    rows.map((row) => row.id),
    db,
  );

  for (const row of rows) {
    const current = digest.get(row.deploymentId) ?? {
      scanners: [],
      verdict: null,
      counts: { ...EMPTY_SEVERITY_COUNTS },
    };

    const scanner = row.scanner as ScannerKey;
    if (!current.scanners.includes(scanner)) current.scanners.push(scanner);

    const verdict = row.verdict as ScanVerdict;
    if (verdict === 'fail') current.verdict = 'fail';
    else if (current.verdict !== 'fail' && verdict === 'unknown') current.verdict = 'unknown';
    else if (current.verdict === null) current.verdict = verdict;

    const runCounts = counts.get(row.id);
    if (runCounts) {
      for (const severity of Object.keys(runCounts) as Severity[]) {
        current.counts[severity] += runCounts[severity];
      }
    }

    digest.set(row.deploymentId, current);
  }

  return digest;
}
