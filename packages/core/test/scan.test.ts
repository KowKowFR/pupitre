import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { grypeCommand } from '../src/scanners/grype.js';
import { asToolOwner, MACHINE_PLATFORM_FLAG } from '../src/scanners/run.js';
import { syftCommand } from '../src/scanners/syft.js';
import { trivyCommand } from '../src/scanners/trivy.js';
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
 * Le point clé de la normalisation : deux scanners qui voient la même CVE sur le même
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

  it("`negligible`, hérité du schéma d'origine, est relu en LOW", () => {
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

describe('scanners — où lire les images', () => {
  const docker = { kind: 'docker' } as const;
  const k3s = {
    kind: 'containerd',
    address: '/run/k3s/containerd/containerd.sock',
    namespace: 'k8s.io',
    elevated: true,
  } as const;

  it('sur Docker, les trois commandes restent celles d’avant, sans élévation', () => {
    const trivy = trivyCommand('app-blog/web:3', docker, 600_000);
    assert.equal(trivy.sudo, false);
    assert.doesNotMatch(trivy.command, /CONTAINERD|image-src|sudo/);
    assert.match(
      trivy.command,
      /trivy image --format json --scanners vuln --no-progress --timeout 9m 'app-blog\/web:3'$/,
    );
    const grype = grypeCommand('app-blog/web:3', docker);
    assert.equal(grype.sudo, false);
    assert.match(grype.command, /grype 'app-blog\/web:3' -o json$/);
    const syft = syftCommand('app-blog/web:3', docker, 'cyclonedx');
    assert.equal(syft.sudo, false);
    assert.match(syft.command, /syft scan 'app-blog\/web:3' -o cyclonedx-json$/);
  });

  it('sur le containerd de k3s, chaque outil y est pointé, puis retombe sur le registry', () => {
    for (const { command, sudo } of [
      trivyCommand('app-blog/web:3', k3s, 600_000),
      grypeCommand('app-blog/web:3', k3s),
      syftCommand('app-blog/web:3', k3s, 'cyclonedx'),
    ]) {
      assert.equal(sudo, true);
      assert.match(
        command,
        /CONTAINERD_ADDRESS='\/run\/k3s\/containerd\/containerd\.sock' CONTAINERD_NAMESPACE='k8s\.io'/,
      );
      assert.match(command, /SUDO_USER/);
    }
    // Containerd ne connaît que les noms complets : Trivy échouait sous le nom court.
    assert.match(
      trivyCommand('app-blog/web:3', k3s, 600_000).command,
      /--image-src containerd,remote 'docker\.io\/app-blog\/web:3'$/m,
    );
    assert.match(
      trivyCommand('x', k3s, 600_000).command,
      /--image-src containerd,remote 'docker\.io\/library\/x:latest'/,
    );
    assert.match(
      grypeCommand('x', k3s).command,
      /--from containerd --from registry --platform "linux\//,
    );
    assert.match(
      syftCommand('x', k3s, 'cyclonedx').command,
      /--from containerd --from registry --platform "linux\/.*-o cyclonedx-json/,
    );
  });

  it('un containerd ouvert à l’utilisateur ne demande pas sudo', () => {
    const open = { ...k3s, elevated: false };
    const trivy = trivyCommand('x', open, 600_000);
    assert.equal(trivy.sudo, false);
    assert.doesNotMatch(trivy.command, /SUDO_USER/);
  });

  it('sous sudo, l’outil retrouve le HOME de l’utilisateur et garde son code de sortie', () => {
    const user = userInfo().username;
    const script = asToolOwner('printf %s "$HOME"; exit 3', '"$HOME"/.inexistant');
    const run = spawnSync('sh', ['-c', script], {
      // Ce que sudo laisse derrière lui : le HOME de root, et qui l'a appelé.
      env: { PATH: process.env.PATH, HOME: '/var/root-de-test', SUDO_USER: user },
      encoding: 'utf8',
    });
    assert.equal(run.status, 3);
    assert.equal(run.stdout, homedir());
  });

  it('sans sudo, rien ne change', () => {
    const run = spawnSync('sh', ['-c', asToolOwner('printf %s "$HOME"', '/nulle-part')], {
      env: { PATH: process.env.PATH, HOME: '/maison' },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, '/maison');
  });

  it('la plateforme suit uname -m', () => {
    const run = spawnSync('sh', ['-c', `echo ${MACHINE_PLATFORM_FLAG}`], { encoding: 'utf8' });
    const arch = ({ x64: 'amd64', arm64: 'arm64' } as Record<string, string>)[process.arch];
    assert.ok(arch, `architecture de test inattendue : ${process.arch}`);
    assert.equal(run.stdout.trim(), `--platform linux/${arch}`);
  });
});
