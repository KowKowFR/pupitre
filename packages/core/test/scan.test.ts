import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_UI_SCAN_CONFIG,
  EMPTY_SCAN_CONFIG,
  SCANNERS,
  SCANNER_KEYS,
  blocks,
  compareSeverity,
  countBySeverity,
  parseScanConfig,
  scanConfigSchema,
  severityFromDb,
  severityToDb,
  verdictFor,
  worstSeverity,
  type Finding,
  type Severity,
} from '../src/scan.js';
import {
  availableScanners,
  getScanner,
  normalizeGrypeReport,
  normalizeTrivyReport,
} from '../src/scanners/index.js';

/**
 * Le point clé du jalon 6 : deux scanners qui voient la même CVE sur le même
 * paquet doivent produire le *même* `Finding`. Ces tests comparent les deux
 * traductions sur des sorties réelles, sans jamais ouvrir de session SSH.
 */

/** Extrait de `trivy image --format json` sur une image Alpine ancienne. */
const TRIVY_OUTPUT = {
  ArtifactName: 'node:16-alpine',
  Results: [
    {
      Target: 'node:16-alpine (alpine 3.16.9)',
      Vulnerabilities: [
        {
          VulnerabilityID: 'CVE-2023-5363',
          PkgName: 'libcrypto3',
          InstalledVersion: '3.0.8-r4',
          FixedVersion: '3.0.12-r0',
          Severity: 'HIGH',
          Title: 'openssl: Incorrect cipher key and IV length processing',
          PrimaryURL: 'https://avd.aquasec.com/nvd/cve-2023-5363',
        },
        {
          VulnerabilityID: 'CVE-2022-3602',
          PkgName: 'libssl3',
          InstalledVersion: '3.0.8-r4',
          Severity: 'critical',
          Description: 'X.509 Email Address Buffer Overflow',
          PrimaryURL: 'https://avd.aquasec.com/nvd/cve-2022-3602',
        },
        {
          // Sans identifiant ni paquet : rien à normaliser, on écarte.
          Severity: 'HIGH',
        },
      ],
    },
    { Target: 'usr/local/bin/node', Vulnerabilities: null },
  ],
};

/** La même image, vue par `grype -o json`. */
const GRYPE_OUTPUT = {
  matches: [
    {
      vulnerability: {
        id: 'CVE-2023-5363',
        severity: 'High',
        dataSource: 'https://avd.aquasec.com/nvd/cve-2023-5363',
        description: 'openssl: Incorrect cipher key and IV length processing',
        fix: { versions: ['3.0.12-r0', '3.1.4-r0'], state: 'fixed' },
      },
      artifact: { name: 'libcrypto3', version: '3.0.8-r4' },
    },
    {
      vulnerability: {
        id: 'CVE-2022-3602',
        severity: 'Critical',
        dataSource: 'https://avd.aquasec.com/nvd/cve-2022-3602',
        description: 'X.509 Email Address Buffer Overflow',
        fix: { versions: [], state: 'not-fixed' },
      },
      artifact: { name: 'libssl3', version: '3.0.8-r4' },
    },
    {
      vulnerability: {
        id: 'CVE-2021-0000',
        severity: 'Negligible',
        description: '',
        fix: { versions: [], state: 'unknown' },
      },
      relatedVulnerabilities: [
        { id: 'CVE-2021-0000', description: 'sans gravité', dataSource: 'https://example.test' },
      ],
      artifact: { name: 'busybox', version: '1.35.0-r17' },
    },
  ],
};

describe('normalisation des rapports', () => {
  it('Trivy et Grype produisent le même Finding pour la même CVE', () => {
    const trivy = normalizeTrivyReport(TRIVY_OUTPUT);
    const grype = normalizeGrypeReport(GRYPE_OUTPUT);

    for (const cve of ['CVE-2023-5363', 'CVE-2022-3602']) {
      const fromTrivy = trivy.find((finding) => finding.cveId === cve);
      const fromGrype = grype.find((finding) => finding.cveId === cve);

      assert.ok(fromTrivy, `${cve} absente du rapport Trivy`);
      assert.ok(fromGrype, `${cve} absente du rapport Grype`);

      assert.equal(fromGrype.severity, fromTrivy.severity, `${cve} : sévérités divergentes`);
      assert.equal(fromGrype.package, fromTrivy.package);
      assert.equal(fromGrype.installedVersion, fromTrivy.installedVersion);
      assert.equal(fromGrype.fixedVersion, fromTrivy.fixedVersion);
      assert.equal(fromGrype.primaryUrl, fromTrivy.primaryUrl);
      assert.equal(fromGrype.title, fromTrivy.title);
    }
  });

  it("écarte les entrées Trivy sans identifiant ni paquet", () => {
    assert.equal(normalizeTrivyReport(TRIVY_OUTPUT).length, 2);
  });

  it('Trivy : une sévérité en minuscules est ramenée sur l’échelle commune', () => {
    const finding = normalizeTrivyReport(TRIVY_OUTPUT).find(
      (candidate) => candidate.cveId === 'CVE-2022-3602',
    );
    assert.equal(finding?.severity, 'CRITICAL');
    // Pas de correctif publié : `FixedVersion` absent chez Trivy, tableau vide
    // chez Grype — les deux donnent `null`.
    assert.equal(finding?.fixedVersion, null);
  });

  it('Grype : Negligible devient LOW', () => {
    const finding = normalizeGrypeReport(GRYPE_OUTPUT).find(
      (candidate) => candidate.cveId === 'CVE-2021-0000',
    );
    assert.equal(finding?.severity, 'LOW');
    // Description vide : on se rabat sur la vulnérabilité liée.
    assert.equal(finding?.title, 'sans gravité');
    assert.equal(finding?.primaryUrl, 'https://example.test');
  });

  it('une sévérité inconnue ne traverse pas la frontière telle quelle', () => {
    const trivy = normalizeTrivyReport({
      Results: [{ Vulnerabilities: [{ VulnerabilityID: 'X', PkgName: 'p', Severity: 'BIZARRE' }] }],
    });
    const grype = normalizeGrypeReport({
      matches: [{ vulnerability: { id: 'X', severity: 'bizarre' }, artifact: { name: 'p' } }],
    });
    assert.equal(trivy[0]?.severity, 'UNKNOWN');
    assert.equal(grype[0]?.severity, 'UNKNOWN');
  });
});

describe('seuil de blocage', () => {
  const findings: Finding[] = [
    finding('CVE-1', 'HIGH'),
    finding('CVE-2', 'MEDIUM'),
    finding('CVE-3', 'LOW'),
  ];

  it('CRITICAL ne bloque pas sur un HIGH', () => {
    assert.equal(blocks('HIGH', 'CRITICAL'), false);
    assert.equal(verdictFor('vulnerability', findings, 'CRITICAL'), 'pass');
  });

  it('HIGH bloque sur un HIGH comme sur un CRITICAL', () => {
    assert.equal(blocks('HIGH', 'HIGH'), true);
    assert.equal(blocks('CRITICAL', 'HIGH'), true);
    assert.equal(verdictFor('vulnerability', findings, 'HIGH'), 'fail');
  });

  it('NONE ne bloque jamais, pas même sur un CRITICAL', () => {
    assert.equal(blocks('CRITICAL', 'NONE'), false);
    assert.equal(
      verdictFor('vulnerability', [...findings, finding('CVE-4', 'CRITICAL')], 'NONE'),
      'pass',
    );
  });

  it('un SBOM ne bloque jamais, quel que soit le seuil', () => {
    assert.equal(verdictFor('sbom', [], 'CRITICAL'), 'pass');
  });

  it('compte et pire sévérité', () => {
    const counts = countBySeverity(findings);
    assert.deepEqual(counts, { CRITICAL: 0, HIGH: 1, MEDIUM: 1, LOW: 1, UNKNOWN: 0 });
    assert.equal(worstSeverity(counts), 'HIGH');
    assert.equal(worstSeverity(countBySeverity([])), null);
  });

  it('le tri place les critiques en tête', () => {
    const order: Severity[] = ['LOW', 'CRITICAL', 'UNKNOWN', 'HIGH'];
    assert.deepEqual([...order].sort(compareSeverity), ['CRITICAL', 'HIGH', 'LOW', 'UNKNOWN']);
  });
});

describe('configuration de scan', () => {
  it("par défaut, l'API ne scanne rien", () => {
    assert.deepEqual(scanConfigSchema.parse({}), EMPTY_SCAN_CONFIG);
    assert.deepEqual(parseScanConfig(null), EMPTY_SCAN_CONFIG);
    assert.deepEqual(parseScanConfig({ scanners: ['inconnu'] }), EMPTY_SCAN_CONFIG);
  });

  it('le formulaire, lui, coche tout et bloque sur CRITICAL', () => {
    assert.deepEqual(DEFAULT_UI_SCAN_CONFIG.scanners, [...SCANNER_KEYS]);
    assert.equal(DEFAULT_UI_SCAN_CONFIG.failOn, 'CRITICAL');
  });

  it('une sélection partielle est valide', () => {
    const config = parseScanConfig({ scanners: ['grype'], failOn: 'CRITICAL' });
    assert.deepEqual(config.scanners, ['grype']);
    assert.equal(config.failOn, 'CRITICAL');
  });

  it('un scanner coché deux fois ne tourne qu’une fois', () => {
    assert.deepEqual(parseScanConfig({ scanners: ['trivy', 'trivy'] }).scanners, ['trivy']);
  });
});

describe('fabrique', () => {
  it('chaque clé du vocabulaire a une implémentation cohérente', () => {
    assert.deepEqual(availableScanners(), [...SCANNER_KEYS]);
    for (const key of SCANNER_KEYS) {
      const scanner = getScanner(key);
      assert.equal(scanner.key, key);
      assert.equal(scanner.kind, SCANNERS[key].kind);
    }
  });

  it('un scanner « sbom » déclare un format, un scanner de vulnérabilités non', () => {
    for (const key of SCANNER_KEYS) {
      const descriptor = SCANNERS[key];
      assert.equal(descriptor.sbomFormat !== null, descriptor.kind === 'sbom');
    }
  });
});

describe('correspondance avec les enums Postgres', () => {
  it('aller-retour sur toute l’échelle', () => {
    for (const severity of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] as Severity[]) {
      assert.equal(severityFromDb(severityToDb(severity)), severity);
    }
  });

  it('`negligible`, hérité du jalon 1, est relu en LOW', () => {
    assert.equal(severityFromDb('negligible'), 'LOW');
  });
});

function finding(cveId: string, severity: Severity): Finding {
  return {
    cveId,
    severity,
    package: 'p',
    installedVersion: '1.0',
    fixedVersion: null,
    title: null,
    primaryUrl: null,
  };
}
