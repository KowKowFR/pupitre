import { z } from 'zod';

import type { Translated, UiLanguage } from './i18n.js';

/**
 * Shapes of the scan report — the normalized vocabulary, without execution.
 *
 * This file depends on no SSH building block: the panel imports it to show
 * findings and validate the form, without ever pulling `ssh2` into its
 * dependency graph. The same split as `preflight.ts` (types) / `ssh/`
 * (execution), and as `ports.ts` (interface) / `packages/db` (implementation).
 *
 * Execution lives in `@pupitre/core/scanners`.
 */

// ─── severity scale ───────────────────────────────────────────────────────────

/**
 * A common scale. Trivy and Grype do not describe a vulnerability the same way:
 * each implementation maps its own onto this one, once, on its side. Nothing
 * downstream knows a particular scanner's vocabulary.
 *
 * `Negligible` (Grype) is mapped to `LOW`: our scale has no sixth notch, and
 * filing it under `UNKNOWN` would make it more alarming than it is.
 */
export const severitySchema = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']);
export type Severity = z.infer<typeof severitySchema>;

/** From the most to the least severe. Used for sorting and for comparing with the threshold. */
export const SEVERITY_ORDER: readonly Severity[] = [
  'CRITICAL',
  'HIGH',
  'MEDIUM',
  'LOW',
  'UNKNOWN',
];

const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  UNKNOWN: 0,
};

export function severityRank(severity: Severity): number {
  return SEVERITY_RANK[severity];
}

/** Descending sort: critical ones first. */
export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY_RANK[b] - SEVERITY_RANK[a];
}

// ─── blocking threshold ───────────────────────────────────────────────────────

/** Blocking policy, stored as data and never hard-coded. */
export const failOnSchema = z.enum(['CRITICAL', 'HIGH', 'NONE']);
export type FailOn = z.infer<typeof failOnSchema>;

/**
 * The threshold's three notches, spelled out.
 *
 * They show in the security settings' dropdown and on a deployment's record —
 * hence in the instance's language. Only the **keys** are shared: `CRITICAL`
 * and `HIGH` are the scale's names, they are not translated; the sentence
 * around them is.
 */
const failOnLabelsFr = {
  CRITICAL: 'Bloquer sur CRITICAL',
  HIGH: 'Bloquer sur HIGH ou plus',
  NONE: 'Ne pas bloquer',
} as const satisfies Record<FailOn, string>;

const failOnLabelsEn: Translated<typeof failOnLabelsFr> = {
  CRITICAL: 'Block on CRITICAL',
  HIGH: 'Block on HIGH and above',
  NONE: 'Never block',
};

export const failOnLabels = { fr: failOnLabelsFr, en: failOnLabelsEn };

/** A threshold's label in a given language. */
export function failOnLabel(failOn: FailOn, language: UiLanguage): string {
  const table: Record<FailOn, string> = failOnLabels[language] ?? failOnLabelsFr;
  return table[failOn];
}

/**
 * @deprecated Use `failOnLabel(failOn, language)`. Kept for callers that show
 * nothing — the source stays French.
 */
export const FAIL_ON_LABELS: Record<FailOn, string> = failOnLabelsFr;

/** Does a finding reach the threshold? `NONE` never blocks. */
export function blocks(severity: Severity, failOn: FailOn): boolean {
  if (failOn === 'NONE') return false;
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[failOn];
}

// ─── scanners ─────────────────────────────────────────────────────────────────

export const scannerKeySchema = z.enum(['trivy', 'grype', 'syft']);
export type ScannerKey = z.infer<typeof scannerKeySchema>;

export const scanKindSchema = z.enum(['vulnerability', 'sbom']);
export type ScanKind = z.infer<typeof scanKindSchema>;

export const sbomFormatSchema = z.enum(['cyclonedx', 'spdx']);
export type SbomFormat = z.infer<typeof sbomFormatSchema>;

/**
 * Where a runtime keeps the images it runs — what a scanner needs to know to
 * read them, without knowing which runtime put them there.
 *
 * It is the driver that declares it (`DeploymentDriver.imageStore()`) and each
 * scanner that translates it into its own terms (environment variables, image
 * source, platform). Neither the worker nor the scanners test the runtime.
 *
 * - `docker`: the Docker daemon, reached through the user's `docker` group.
 * - `containerd`: a containerd through its socket and its namespace;
 *   `elevated` when the socket is reserved to root — the tool then runs under
 *   `sudo`, according to the target's elevation method.
 */
export type ImageStore =
  | { kind: 'docker' }
  | { kind: 'containerd'; address: string; namespace: string; elevated: boolean };

/**
 * What each scanner looks at.
 *
 * A scanner's **name** is a proper noun and stays as is in both languages (see
 * `scannerLabel`); the sentence that says what it does is shown under a scan's
 * card and is translated.
 */
const scannerDescriptionsFr = {
  trivy: 'Vulnérabilités des paquets système et applicatifs',
  grype: 'Vulnérabilités, base Anchore',
  syft: 'Inventaire des composants (SBOM CycloneDX)',
} as const satisfies Record<ScannerKey, string>;

const scannerDescriptionsEn: Translated<typeof scannerDescriptionsFr> = {
  trivy: 'Vulnerabilities in system and application packages',
  grype: 'Vulnerabilities, Anchore database',
  syft: 'Component inventory (CycloneDX SBOM)',
};

export const scannerDescriptions = { fr: scannerDescriptionsFr, en: scannerDescriptionsEn };

export function scannerDescription(key: ScannerKey, language: UiLanguage): string {
  const table: Record<ScannerKey, string> = scannerDescriptions[language] ?? scannerDescriptionsFr;
  return table[key];
}

/**
 * The scanners' identity card — a data table, never a branch.
 *
 * It lives here, with the types, so that the UI and the routes can name a
 * scanner without importing its implementation (hence without pulling `ssh2`).
 * It is the only place in the project where the three names are written:
 * elsewhere, we read `SCANNERS[key]`.
 */
export const SCANNERS: Record<
  ScannerKey,
  {
    label: string;
    kind: ScanKind;
    description: string;
    /** Filled in for `sbom` scanners only. */
    sbomFormat: SbomFormat | null;
    /** Extension of the downloaded file, for `sbom` scanners. */
    sbomExtension: string | null;
    mediaType: string;
  }
> = {
  trivy: {
    label: 'Trivy',
    kind: 'vulnerability',
    description: scannerDescriptionsFr.trivy,
    sbomFormat: null,
    sbomExtension: null,
    mediaType: 'application/json',
  },
  grype: {
    label: 'Grype',
    kind: 'vulnerability',
    description: scannerDescriptionsFr.grype,
    sbomFormat: null,
    sbomExtension: null,
    mediaType: 'application/json',
  },
  syft: {
    label: 'Syft',
    kind: 'sbom',
    description: scannerDescriptionsFr.syft,
    sbomFormat: 'cyclonedx',
    sbomExtension: 'cdx.json',
    mediaType: 'application/vnd.cyclonedx+json',
  },
};

export const SCANNER_KEYS: readonly ScannerKey[] = scannerKeySchema.options;

/** Scanners able to produce a blocking verdict. */
export const VULNERABILITY_SCANNERS: readonly ScannerKey[] = SCANNER_KEYS.filter(
  (key) => SCANNERS[key].kind === 'vulnerability',
);

/**
 * A scanner's name. **No language argument, on purpose**: "Trivy", "Grype" and
 * "Syft" are proper nouns.
 */
export function scannerLabel(key: ScannerKey): string {
  return SCANNERS[key].label;
}

// ─── a scan's configuration ───────────────────────────────────────────────────

/**
 * Content of `deployments.scan_config`.
 *
 * By default: no scanner. Scanning is an explicit decision of the caller, and
 * the API must not impose one on a client that does not mention it — the UI's
 * form arrives with the three boxes ticked.
 */
export const scanConfigSchema = z.object({
  scanners: z.array(scannerKeySchema).max(SCANNER_KEYS.length).default([]),
  failOn: failOnSchema.default('NONE'),
  /**
   * Only block on a **fixable** vulnerability — one for which the scanner knows a
   * version that fixes it. A vulnerability without a fix is not repaired by
   * redeploying: blocking on it stops the release without offering anything to
   * do. Optional: deployments saved before stay readable, and mean "everything
   * blocks".
   */
  onlyFixable: z.boolean().optional(),
  /**
   * Why there is no scanner, when there is none.
   *
   * Without it, the "scan" step could not tell "the user did not ask for one"
   * from "the instance disabled scanning", and would say the same thing in both
   * cases. Optional: deployments saved before this field stay readable.
   */
  disabledBy: z.literal('settings').optional(),
});

export type ScanConfig = z.infer<typeof scanConfigSchema>;

export const EMPTY_SCAN_CONFIG: ScanConfig = { scanners: [], failOn: 'NONE' };

/** The form's default: everything ticked, blocking on CRITICAL. */
export const DEFAULT_UI_SCAN_CONFIG: ScanConfig = {
  scanners: [...SCANNER_KEYS],
  failOn: 'CRITICAL',
};

/** Reads a value coming from the database (jsonb, possibly `null`). */
export function parseScanConfig(value: unknown): ScanConfig {
  if (value === null || value === undefined) return EMPTY_SCAN_CONFIG;
  const parsed = scanConfigSchema.safeParse(value);
  return parsed.success ? dedupeScanners(parsed.data) : EMPTY_SCAN_CONFIG;
}

/** A box ticked twice must not run the scanner twice. */
export function dedupeScanners(config: ScanConfig): ScanConfig {
  return { ...config, scanners: [...new Set(config.scanners)] };
}

// ─── normalized report ────────────────────────────────────────────────────────

/**
 * Normalized vulnerability.
 *
 * Two scanners that see the same CVE on the same package must produce the same
 * `Finding`. That is the whole point of normalization: beyond this boundary,
 * nothing knows who spoke anymore.
 */
export const findingSchema = z.object({
  cveId: z.string().min(1).max(200),
  severity: severitySchema,
  package: z.string().min(1).max(400),
  installedVersion: z.string().max(200).nullable().default(null),
  fixedVersion: z.string().max(200).nullable().default(null),
  title: z.string().max(2000).nullable().default(null),
  primaryUrl: z.string().max(1000).nullable().default(null),
});

export type Finding = z.infer<typeof findingSchema>;

export const sbomSchema = z.object({
  format: sbomFormatSchema,
  /** Serialized document, as produced by the tool. */
  content: z.string(),
});

export type Sbom = z.infer<typeof sbomSchema>;

export type ScanReport = {
  scanner: ScannerKey;
  kind: ScanKind;
  durationMs: number;
  /** Empty for an SBOM. */
  findings: Finding[];
  sbom?: Sbom;
  /** The tool's raw output, stored as is in jsonb. */
  raw: unknown;
};

// ─── aggregates ───────────────────────────────────────────────────────────────

export type SeverityCounts = Record<Severity, number>;

export const EMPTY_SEVERITY_COUNTS: SeverityCounts = {
  CRITICAL: 0,
  HIGH: 0,
  MEDIUM: 0,
  LOW: 0,
  UNKNOWN: 0,
};

export function countBySeverity(findings: readonly { severity: Severity }[]): SeverityCounts {
  const counts: SeverityCounts = { ...EMPTY_SEVERITY_COUNTS };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

export function totalFindings(counts: SeverityCounts): number {
  return SEVERITY_ORDER.reduce((sum, severity) => sum + counts[severity], 0);
}

/** The most severe severity present, or `null` if there is no finding. */
export function worstSeverity(counts: SeverityCounts): Severity | null {
  return SEVERITY_ORDER.find((severity) => counts[severity] > 0) ?? null;
}

export const scanVerdictSchema = z.enum(['pass', 'fail', 'unknown']);
export type ScanVerdict = z.infer<typeof scanVerdictSchema>;

export const scanRunStatusSchema = z.enum([
  'pending',
  'running',
  'success',
  'failed',
  'skipped',
]);
export type ScanRunStatus = z.infer<typeof scanRunStatusSchema>;

/**
 * A scan's verdict: does it block?
 *
 * An SBOM never blocks — it states no vulnerability. It is the `kind` that
 * decides, not the tool's name.
 */
export function verdictFor(
  kind: ScanKind,
  findings: readonly ScannedFinding[],
  policy: FailOn | ScanPolicy,
): ScanVerdict {
  if (kind !== 'vulnerability') return 'pass';
  const resolved: ScanPolicy =
    typeof policy === 'string' ? { failOn: policy, onlyFixable: false, acceptances: [] } : policy;
  return findings.some((finding) => findingBlocks(finding, resolved)) ? 'fail' : 'pass';
}

// ─── fixable, accepted, blocking ──────────────────────────────────────────────

/**
 * What is needed from a finding to judge whether it blocks. The optional fields
 * are missing when only the severity is known — then only the threshold counts.
 */
export type ScannedFinding = {
  severity: Severity;
  cveId?: string;
  package?: string;
  fixedVersion?: string | null;
};

/** A vulnerability is fixable when the scanner knows a version that fixes it. */
export function isFixable(finding: { fixedVersion?: string | null }): boolean {
  return typeof finding.fixedVersion === 'string' && finding.fixedVersion.trim() !== '';
}

/**
 * A vulnerability **accepted** for an application: it was read, we know why it
 * does not concern us (or not yet), and we wrote it down. It stays displayed,
 * but no longer blocks. `package` set to `null`: the CVE on every package. An
 * expiry makes it lapse — the acceptance does not hold forever unless decided.
 */
export type VulnerabilityAcceptance = {
  cveId: string;
  package: string | null;
  expiresAt: Date | string | null;
};

export const VULNERABILITY_ACCEPTANCE_REASON_MIN = 3;
export const VULNERABILITY_ACCEPTANCE_REASON_MAX = 500;
/** The expiries offered, in days; `null`: no expiry. */
export const VULNERABILITY_ACCEPTANCE_DURATIONS = [30, 90, 180, null] as const;

export const createVulnerabilityAcceptanceSchema = z.object({
  cveId: z.string().trim().min(1).max(200),
  /** `null`: the CVE, whatever the package. */
  package: z.string().trim().min(1).max(400).nullable(),
  reason: z
    .string()
    .trim()
    .min(VULNERABILITY_ACCEPTANCE_REASON_MIN)
    .max(VULNERABILITY_ACCEPTANCE_REASON_MAX),
  /** In days from now; `null`: no expiry. */
  expiresInDays: z.number().int().min(1).max(730).nullable(),
});
export type CreateVulnerabilityAcceptanceInput = z.infer<
  typeof createVulnerabilityAcceptanceSchema
>;

/** The acceptance that covers this finding at the instant `now`, if there is one. */
export function matchingAcceptance<A extends VulnerabilityAcceptance>(
  finding: { cveId?: string; package?: string },
  acceptances: readonly A[],
  now: Date = new Date(),
): A | null {
  if (!finding.cveId) return null;
  const cve = finding.cveId.toUpperCase();
  return (
    acceptances.find(
      (acceptance) =>
        acceptance.cveId.toUpperCase() === cve &&
        (acceptance.package === null || acceptance.package === finding.package) &&
        (acceptance.expiresAt === null || new Date(acceptance.expiresAt).getTime() > now.getTime()),
    ) ?? null
  );
}

/**
 * What decides a scan's verdict: the threshold, only fixable vulnerabilities or
 * all, and the vulnerabilities accepted for the application.
 */
export type ScanPolicy = {
  failOn: FailOn;
  onlyFixable: boolean;
  acceptances: readonly VulnerabilityAcceptance[];
  now?: Date;
};

/** Does this finding block, under this policy? */
export function findingBlocks(finding: ScannedFinding, policy: ScanPolicy): boolean {
  if (!blocks(finding.severity, policy.failOn)) return false;
  if (policy.onlyFixable && !isFixable(finding)) return false;
  return matchingAcceptance(finding, policy.acceptances, policy.now) === null;
}

export type FindingsSummary = {
  total: number;
  /** Fixable: a version that fixes them exists. */
  fixable: number;
  /** Accepted for the application, at this instant. */
  accepted: number;
  /** Those that block under the policy. */
  blocking: number;
};

export function summarizeFindings(
  findings: readonly ScannedFinding[],
  policy: ScanPolicy,
): FindingsSummary {
  let fixable = 0;
  let accepted = 0;
  let blocking = 0;
  for (const finding of findings) {
    if (isFixable(finding)) fixable += 1;
    if (matchingAcceptance(finding, policy.acceptances, policy.now)) accepted += 1;
    if (findingBlocks(finding, policy)) blocking += 1;
  }
  return { total: findings.length, fixable, accepted, blocking };
}

/**
 * An application's setting: its threshold and its fixable rule. `null`: like
 * the instance.
 */
export const applicationScanPolicySchema = z.object({
  failOn: failOnSchema.nullable(),
  onlyFixable: z.boolean().nullable(),
});
export type ApplicationScanPolicy = z.infer<typeof applicationScanPolicySchema>;

export const INHERITED_SCAN_POLICY: ApplicationScanPolicy = { failOn: null, onlyFixable: null };

/**
 * Applies an application's setting to a scan configuration. What is set on the
 * application wins over the instance — it is the application that knows what
 * should block it; what is not set stays as is.
 */
export function withApplicationScanPolicy(
  config: ScanConfig,
  policy: ApplicationScanPolicy,
): ScanConfig {
  // No scanner: a threshold would have nothing to evaluate it.
  if (config.scanners.length === 0) return config;
  return {
    ...config,
    ...(policy.failOn !== null ? { failOn: policy.failOn } : {}),
    ...(policy.onlyFixable !== null ? { onlyFixable: policy.onlyFixable } : {}),
  };
}

// ─── mapping with the Postgres enums ──────────────────────────────────────────

/**
 * The database carries the same notions in lowercase, with a `negligible` notch
 * inherited from the original schema that our scale does not use. The
 * translation lives here, once, rather than in each query.
 */
export const DB_SEVERITIES = [
  'unknown',
  'negligible',
  'low',
  'medium',
  'high',
  'critical',
] as const;
export type DbSeverity = (typeof DB_SEVERITIES)[number];

export function severityToDb(severity: Severity): DbSeverity {
  return severity.toLowerCase() as DbSeverity;
}

export function severityFromDb(value: DbSeverity): Severity {
  return value === 'negligible' ? 'LOW' : (value.toUpperCase() as Severity);
}

export type DbFailOn = 'none' | 'high' | 'critical';

export function failOnToDb(failOn: FailOn): DbFailOn {
  return failOn.toLowerCase() as DbFailOn;
}

export function failOnFromDb(value: DbFailOn): FailOn {
  return value.toUpperCase() as FailOn;
}
