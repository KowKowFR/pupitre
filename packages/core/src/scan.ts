import { z } from 'zod';

import type { Translated, UiLanguage } from './i18n.js';

/**
 * Formes du rapport de scan — le vocabulaire normalisé, sans exécution.
 *
 * Ce fichier ne dépend d'aucune brique SSH : le panel l'importe pour afficher
 * des findings et pour valider le formulaire, sans jamais tirer `ssh2` dans son
 * graphe de dépendances. Même partage que `preflight.ts` (types) / `ssh/`
 * (exécution), et que `ports.ts` (interface) / `packages/db` (implémentation).
 *
 * L'exécution vit dans `@pupitre/core/scanners`.
 */

// ─── échelle de sévérité ──────────────────────────────────────────────────────

/**
 * Échelle commune. Trivy et Grype ne décrivent pas une vulnérabilité de la même
 * façon : chaque implémentation ramène la sienne sur celle-ci, une fois, chez
 * elle. Rien en aval ne connaît le vocabulaire d'un scanner particulier.
 *
 * `Negligible` (Grype) est ramené à `LOW` : notre échelle n'a pas de sixième
 * cran, et la ranger sous `UNKNOWN` la rendrait plus alarmante qu'elle n'est.
 */
export const severitySchema = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']);
export type Severity = z.infer<typeof severitySchema>;

/** De la plus grave à la moins grave. Sert au tri et à la comparaison au seuil. */
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

/** Tri décroissant : les critiques d'abord. */
export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY_RANK[b] - SEVERITY_RANK[a];
}

// ─── seuil de blocage ─────────────────────────────────────────────────────────

/** Politique de blocage, stockée en donnée et jamais codée en dur. */
export const failOnSchema = z.enum(['CRITICAL', 'HIGH', 'NONE']);
export type FailOn = z.infer<typeof failOnSchema>;

/**
 * Les trois crans du seuil, en toutes lettres.
 *
 * Ils s'affichent dans la liste déroulante des paramètres de sécurité et sur
 * la fiche d'un déploiement — donc dans la langue de l'instance. Seules les
 * **clés** sont partagées : `CRITICAL` et `HIGH` sont les noms de l'échelle,
 * ils ne se traduisent pas ; la phrase qui les entoure, si.
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

/**
 * Le libellé d'un seuil dans une langue donnée.
 *
 * Le défaut est le français parce que c'est la langue source : un appelant qui
 * ne sait pas dans quelle langue il parle — un log, un seed — obtient la
 * valeur d'origine plutôt qu'une clé nue.
 */
export function failOnLabel(failOn: FailOn, language: UiLanguage = 'fr'): string {
  const table: Record<FailOn, string> = failOnLabels[language] ?? failOnLabelsFr;
  return table[failOn];
}

/**
 * @deprecated Utiliser `failOnLabel(failOn, language)`. Conservé pour les
 * appelants qui n'affichent rien — la source reste le français.
 */
export const FAIL_ON_LABELS: Record<FailOn, string> = failOnLabelsFr;

/** Un finding atteint-il le seuil ? `NONE` ne bloque jamais. */
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
 * Ce que chaque scanner regarde.
 *
 * Le **nom** d'un scanner est un nom propre et reste tel quel dans les deux
 * langues (cf. `scannerLabel`) ; la phrase qui dit ce qu'il fait, elle,
 * s'affiche sous la carte d'un scan et se traduit.
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

export function scannerDescription(key: ScannerKey, language: UiLanguage = 'fr'): string {
  const table: Record<ScannerKey, string> = scannerDescriptions[language] ?? scannerDescriptionsFr;
  return table[key];
}

/**
 * Carte d'identité des scanners — une table de données, jamais une branche.
 *
 * Elle vit ici, avec les types, pour que l'UI et les routes puissent nommer un
 * scanner sans importer son implémentation (et donc sans tirer `ssh2`). C'est
 * le seul endroit du projet où les trois noms sont écrits : ailleurs, on lit
 * `SCANNERS[key]`.
 */
export const SCANNERS: Record<
  ScannerKey,
  {
    label: string;
    kind: ScanKind;
    description: string;
    /** Renseigné pour les scanners `sbom` uniquement. */
    sbomFormat: SbomFormat | null;
    /** Extension du fichier téléchargé, pour les scanners `sbom`. */
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

/** Scanners capables de produire un verdict de blocage. */
export const VULNERABILITY_SCANNERS: readonly ScannerKey[] = SCANNER_KEYS.filter(
  (key) => SCANNERS[key].kind === 'vulnerability',
);

/**
 * Le nom d'un scanner. **Pas de langue en argument, et c'est voulu** : « Trivy »,
 * « Grype » et « Syft » sont des noms propres.
 */
export function scannerLabel(key: ScannerKey): string {
  return SCANNERS[key].label;
}

// ─── configuration d'un scan ──────────────────────────────────────────────────

/**
 * Contenu de `deployments.scan_config`.
 *
 * Par défaut : aucun scanner. Le scan est une décision explicite de l'appelant,
 * et l'API ne doit pas en imposer une à un client qui n'en parle pas — le
 * formulaire de l'UI, lui, arrive avec les trois cases cochées.
 */
export const scanConfigSchema = z.object({
  scanners: z.array(scannerKeySchema).max(SCANNER_KEYS.length).default([]),
  failOn: failOnSchema.default('NONE'),
  /**
   * Pourquoi il n'y a pas de scanner, quand il n'y en a pas.
   *
   * Sans cela, l'étape « scan » ne saurait pas distinguer « l'utilisateur n'en
   * a pas demandé » de « l'instance a désactivé l'analyse », et dirait la même
   * chose dans les deux cas. Optionnel : les déploiements enregistrés avant ce
   * champ restent lisibles.
   */
  disabledBy: z.literal('settings').optional(),
});

export type ScanConfig = z.infer<typeof scanConfigSchema>;

export const EMPTY_SCAN_CONFIG: ScanConfig = { scanners: [], failOn: 'NONE' };

/** Défaut du formulaire : tout coché, blocage sur CRITICAL. */
export const DEFAULT_UI_SCAN_CONFIG: ScanConfig = {
  scanners: [...SCANNER_KEYS],
  failOn: 'CRITICAL',
};

/** Lit une valeur venue de la base (jsonb, potentiellement `null`). */
export function parseScanConfig(value: unknown): ScanConfig {
  if (value === null || value === undefined) return EMPTY_SCAN_CONFIG;
  const parsed = scanConfigSchema.safeParse(value);
  return parsed.success ? dedupeScanners(parsed.data) : EMPTY_SCAN_CONFIG;
}

/** Une case cochée deux fois ne doit pas faire tourner deux fois le scanner. */
export function dedupeScanners(config: ScanConfig): ScanConfig {
  return { ...config, scanners: [...new Set(config.scanners)] };
}

// ─── rapport normalisé ────────────────────────────────────────────────────────

/**
 * Vulnérabilité normalisée.
 *
 * Deux scanners qui voient la même CVE sur le même paquet doivent produire le
 * même `Finding`. C'est le point clé du jalon : au-delà de cette frontière,
 * plus rien ne sait qui a parlé.
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
  /** Document sérialisé, tel que produit par l'outil. */
  content: z.string(),
});

export type Sbom = z.infer<typeof sbomSchema>;

export type ScanReport = {
  scanner: ScannerKey;
  kind: ScanKind;
  durationMs: number;
  /** Vide pour un SBOM. */
  findings: Finding[];
  sbom?: Sbom;
  /** Sortie brute de l'outil, stockée telle quelle en jsonb. */
  raw: unknown;
};

// ─── agrégats ─────────────────────────────────────────────────────────────────

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

/** Sévérité la plus grave présente, ou `null` si aucun finding. */
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
 * Verdict d'un scan : bloque-t-il ?
 *
 * Un SBOM ne bloque jamais — il n'énonce aucune vulnérabilité. C'est le `kind`
 * qui tranche, pas le nom de l'outil.
 */
export function verdictFor(
  kind: ScanKind,
  findings: readonly { severity: Severity }[],
  failOn: FailOn,
): ScanVerdict {
  if (kind !== 'vulnerability') return 'pass';
  return findings.some((finding) => blocks(finding.severity, failOn)) ? 'fail' : 'pass';
}

// ─── correspondance avec les enums Postgres ───────────────────────────────────

/**
 * La base porte les mêmes notions en minuscules, avec un cran `negligible`
 * hérité du jalon 1 que notre échelle n'utilise pas. La traduction vit ici,
 * une fois, plutôt que dans chaque requête.
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
