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
import { and, asc, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Database } from './client.js';
import { deployments } from './schema/deployments.js';
import { applications, targets } from './schema/infra.js';
import { findings, scanRuns, vulnerabilityAcceptances } from './schema/security.js';

/**
 * Persistence of scans.
 *
 * Two naming gaps inherited from the original schema, absorbed here rather than
 * by a migration: `findings.version` carries the report's `installedVersion`,
 * and `findings.reference` its `primaryUrl`. The rest of the project only sees
 * the normalized report's names.
 *
 * The SBOM has no dedicated column: it *is* the raw output of the tool that
 * produces it, so it lives in `scan_runs.raw`. An extra column would duplicate
 * that value byte for byte, and one would then have to decide which is
 * authoritative. The format is read in `SCANNERS[scanner].sbomFormat`, data, not
 * a branch.
 */

export type ScanRun = typeof scanRuns.$inferSelect;
export type FindingRow = typeof findings.$inferSelect;

/**
 * Size guardrail on `raw`. The Trivy report of an old Debian image easily
 * exceeds a megabyte; beyond this bound we keep a trace of the truncation rather
 * than clog the database.
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
    note: `raw output dropped: ${serialized.length} bytes, beyond the ${RAW_MAX_BYTES} limit`,
  };
}

// ─── writing ──────────────────────────────────────────────────────────────────

export async function createScanRun(
  input: {
    deploymentId: string;
    scanner: ScannerKey;
    failOn: FailOn;
    /** Does the threshold only hold for fixable vulnerabilities? */
    onlyFixable?: boolean;
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
      onlyFixable: input.onlyFixable ?? false,
      verdict: 'unknown',
      imageRef: input.imageRef,
      startedAt: new Date(),
    })
    .returning();

  if (!row) throw new Error('createScanRun: the insert returned nothing');
  return row;
}

/**
 * Closes a run and records its findings, in a single transaction: a half-written
 * scan would give a false verdict.
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

    // Two scanners can see the same CVE twice on the same package (multiple
    // sources): we only write it once per run.
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

    // Postgres caps at 65,535 bound parameters per query: we split.
    const CHUNK = 500;
    for (let index = 0; index < values.length; index += CHUNK) {
      await tx.insert(findings).values(values.slice(index, index + CHUNK));
    }
  });
}

/**
 * Erases a deployment's runs.
 *
 * A retry replays the `scan` step: without this, the security page would add up
 * the previous run's report and the new one's, with no way to tell them apart.
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

/** Marks a run never started (scanner not selected, or step skipped). */
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

// ─── reading ──────────────────────────────────────────────────────────────────

export type ScanRunSummary = {
  id: string;
  deploymentId: string;
  scanner: ScannerKey;
  kind: ScanKind;
  status: ScanRunStatus;
  failOn: FailOn;
  /** The threshold only held for fixable vulnerabilities. */
  onlyFixable: boolean;
  verdict: ScanVerdict;
  imageRef: string | null;
  error: string | null;
  durationMs: number | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  counts: SeverityCounts;
  total: number;
  /** Fixable vulnerabilities: a version that fixes them exists. */
  fixable: number;
  /** Vulnerabilities accepted for the application, **today**. */
  accepted: number;
  /** An SBOM is downloadable as soon as the run succeeded. */
  hasSbom: boolean;
};

function durationOf(startedAt: Date | null, finishedAt: Date | null): number | null {
  if (!startedAt || !finishedAt) return null;
  return Math.max(0, finishedAt.getTime() - startedAt.getTime());
}

function toSummary(
  row: ScanRun,
  counts: SeverityCounts,
  extra: { fixable: number; accepted: number } = { fixable: 0, accepted: 0 },
): ScanRunSummary {
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
    onlyFixable: row.onlyFixable,
    verdict: row.verdict as ScanVerdict,
    imageRef: row.imageRef,
    error: row.error,
    durationMs: durationOf(row.startedAt, row.finishedAt),
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    counts,
    total,
    fixable: extra.fixable,
    accepted: extra.accepted,
    hasSbom: kind === 'sbom' && row.status === 'success' && row.raw !== null,
  };
}

/** A fixable vulnerability: the scanner knows a version that fixes it. */
const FIXABLE = sql`coalesce(${findings.fixedVersion}, '') <> ''`;

/**
 * A vulnerability covered by an ongoing acceptance of the application whose
 * `applicationId` is the SQL expression. The same rule as `matchingAcceptance`
 * in `@pupitre/core`: CVE case-insensitive, named package or all, expiry not
 * passed.
 */
function acceptedFor(applicationId: SQL) {
  return sql`exists (
    select 1 from ${vulnerabilityAcceptances} a
     where a.application_id = ${applicationId}
       and upper(a.cve_id) = upper(${findings.cveId})
       and (a.package is null or a.package = ${findings.package})
       and (a.expires_at is null or a.expires_at > now())
  )`;
}

/** Per run: how many fixable vulnerabilities, how many accepted. */
async function fixableAndAcceptedFor(
  scanRunIds: readonly string[],
  db: Database,
): Promise<Map<string, { fixable: number; accepted: number }>> {
  const map = new Map<string, { fixable: number; accepted: number }>();
  if (scanRunIds.length === 0) return map;
  const rows = await db
    .select({
      scanRunId: findings.scanRunId,
      fixable: sql<number>`count(*) filter (where ${FIXABLE})::int`,
      accepted: sql<number>`count(*) filter (where ${acceptedFor(sql`${deployments.applicationId}`)})::int`,
    })
    .from(findings)
    .innerJoin(scanRuns, eq(scanRuns.id, findings.scanRunId))
    .innerJoin(deployments, eq(deployments.id, scanRuns.deploymentId))
    .where(inArray(findings.scanRunId, [...scanRunIds]))
    .groupBy(findings.scanRunId);
  for (const row of rows) {
    map.set(row.scanRunId, { fixable: Number(row.fixable), accepted: Number(row.accepted) });
  }
  return map;
}

/** Count per severity, for a set of runs, in one query. */
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

  const ids = rows.map((row) => row.id);
  const [counts, extras] = await Promise.all([countsFor(ids, db), fixableAndAcceptedFor(ids, db)]);

  return rows.map((row) =>
    toSummary(row, counts.get(row.id) ?? { ...EMPTY_SEVERITY_COUNTS }, extras.get(row.id)),
  );
}

export async function getScanRun(
  id: string,
  db: Database = getDb(),
): Promise<
  (ScanRunSummary & { applicationId: string; applicationSlug: string; targetName: string }) | null
> {
  const [row] = await db
    .select({
      run: scanRuns,
      applicationId: applications.id,
      applicationSlug: applications.slug,
      targetName: targets.name,
    })
    .from(scanRuns)
    .innerJoin(deployments, eq(deployments.id, scanRuns.deploymentId))
    .innerJoin(applications, eq(applications.id, deployments.applicationId))
    .innerJoin(targets, eq(targets.id, deployments.targetId))
    .where(eq(scanRuns.id, id));

  if (!row) return null;
  const [counts, extras] = await Promise.all([
    countsFor([row.run.id], db),
    fixableAndAcceptedFor([row.run.id], db),
  ]);

  return {
    ...toSummary(
      row.run,
      counts.get(row.run.id) ?? { ...EMPTY_SEVERITY_COUNTS },
      extras.get(row.run.id),
    ),
    applicationId: row.applicationId,
    applicationSlug: row.applicationSlug,
    targetName: row.targetName,
  };
}

/** A run's raw output. For an `sbom` scanner, it is the document. */
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
 * Sorting by descending severity on the database side: a page of 50 findings
 * must start with the critical ones, not with what the insert left first.
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

/**
 * What is looked at in the list: everything, the fixable vulnerabilities, those
 * without a fix, or those accepted for the application.
 */
export const FINDING_VIEWS = ['all', 'fixable', 'unfixable', 'accepted'] as const;
export type FindingViewFilter = (typeof FINDING_VIEWS)[number];

export const findingQuerySchema = z.object({
  severity: severitySchema.optional(),
  view: z.enum(FINDING_VIEWS).default('all'),
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
 * The filter is on the common scale: asking for `LOW` must also bring the
 * database's `negligible` ones, which are `LOW` from the report's point of view.
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
  // The run's application: it is the one carrying the acceptances.
  const applicationOfRun = sql`(select d.application_id from ${scanRuns} r
    join ${deployments} d on d.id = r.deployment_id where r.id = ${scanRunId})`;
  const viewFilter = {
    all: undefined,
    fixable: FIXABLE,
    unfixable: sql`not (${FIXABLE})`,
    accepted: acceptedFor(applicationOfRun),
  }[query.view];
  const where = and(
    eq(findings.scanRunId, scanRunId),
    query.severity ? severityFilter(findings.severity, query.severity) : undefined,
    viewFilter,
  );

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

// ─── cross-cutting view ───────────────────────────────────────────────────────

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

// ─── deployments history ──────────────────────────────────────────────────────

export type DeploymentScanDigest = {
  scanners: ScannerKey[];
  /** `fail` as soon as a run blocks, `unknown` if one failed. */
  verdict: ScanVerdict | null;
  counts: SeverityCounts;
};

/** Summary per deployment, for the history's "Scans" column. */
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
