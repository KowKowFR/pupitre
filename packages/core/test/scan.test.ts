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
 * The key point of normalization: two scanners that see the same CVE on the same
 * package must produce the *same* `Finding`. These tests compare both
 * translations on real outputs, without ever opening an SSH session.
 */

/** Excerpt of `trivy image --format json` on an old Alpine image. */
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
          // Without an identifier or a package: nothing to normalize, we discard.
          Severity: 'HIGH',
        },
      ],
    },
    { Target: 'usr/local/bin/node', Vulnerabilities: null },
  ],
};

/** The same image, seen by `grype -o json`. */
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

describe('reports normalization', () => {
  it('Trivy and Grype produce the same Finding for the same CVE', () => {
    const trivy = normalizeTrivyReport(TRIVY_OUTPUT);
    const grype = normalizeGrypeReport(GRYPE_OUTPUT);

    for (const cve of ['CVE-2023-5363', 'CVE-2022-3602']) {
      const fromTrivy = trivy.find((finding) => finding.cveId === cve);
      const fromGrype = grype.find((finding) => finding.cveId === cve);

      assert.ok(fromTrivy, `${cve} missing from the Trivy report`);
      assert.ok(fromGrype, `${cve} missing from the Grype report`);

      assert.equal(fromGrype.severity, fromTrivy.severity, `${cve}: diverging severities`);
      assert.equal(fromGrype.package, fromTrivy.package);
      assert.equal(fromGrype.installedVersion, fromTrivy.installedVersion);
      assert.equal(fromGrype.fixedVersion, fromTrivy.fixedVersion);
      assert.equal(fromGrype.primaryUrl, fromTrivy.primaryUrl);
      assert.equal(fromGrype.title, fromTrivy.title);
    }
  });

  it("discards the Trivy entries without an identifier or a package", () => {
    assert.equal(normalizeTrivyReport(TRIVY_OUTPUT).length, 2);
  });

  it('Trivy: a lowercase severity is brought onto the common scale', () => {
    const finding = normalizeTrivyReport(TRIVY_OUTPUT).find(
      (candidate) => candidate.cveId === 'CVE-2022-3602',
    );
    assert.equal(finding?.severity, 'CRITICAL');
    // No published fix: `FixedVersion` absent at Trivy, empty array at Grype —
    // both give `null`.
    assert.equal(finding?.fixedVersion, null);
  });

  it('Grype: Negligible becomes LOW', () => {
    const finding = normalizeGrypeReport(GRYPE_OUTPUT).find(
      (candidate) => candidate.cveId === 'CVE-2021-0000',
    );
    assert.equal(finding?.severity, 'LOW');
    // Empty description: we fall back on the related vulnerability.
    assert.equal(finding?.title, 'sans gravité');
    assert.equal(finding?.primaryUrl, 'https://example.test');
  });

  it('an unknown severity does not cross the boundary as is', () => {
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

describe('blocking threshold', () => {
  const findings: Finding[] = [
    finding('CVE-1', 'HIGH'),
    finding('CVE-2', 'MEDIUM'),
    finding('CVE-3', 'LOW'),
  ];

  it('CRITICAL does not block on a HIGH', () => {
    assert.equal(blocks('HIGH', 'CRITICAL'), false);
    assert.equal(verdictFor('vulnerability', findings, 'CRITICAL'), 'pass');
  });

  it('HIGH blocks on a HIGH as on a CRITICAL', () => {
    assert.equal(blocks('HIGH', 'HIGH'), true);
    assert.equal(blocks('CRITICAL', 'HIGH'), true);
    assert.equal(verdictFor('vulnerability', findings, 'HIGH'), 'fail');
  });

  it('NONE never blocks, not even on a CRITICAL', () => {
    assert.equal(blocks('CRITICAL', 'NONE'), false);
    assert.equal(
      verdictFor('vulnerability', [...findings, finding('CVE-4', 'CRITICAL')], 'NONE'),
      'pass',
    );
  });

  it('an SBOM never blocks, whatever the threshold', () => {
    assert.equal(verdictFor('sbom', [], 'CRITICAL'), 'pass');
  });

  it('count and worst severity', () => {
    const counts = countBySeverity(findings);
    assert.deepEqual(counts, { CRITICAL: 0, HIGH: 1, MEDIUM: 1, LOW: 1, UNKNOWN: 0 });
    assert.equal(worstSeverity(counts), 'HIGH');
    assert.equal(worstSeverity(countBySeverity([])), null);
  });

  it('sorting puts the critical ones first', () => {
    const order: Severity[] = ['LOW', 'CRITICAL', 'UNKNOWN', 'HIGH'];
    assert.deepEqual([...order].sort(compareSeverity), ['CRITICAL', 'HIGH', 'LOW', 'UNKNOWN']);
  });
});

describe('scan configuration', () => {
  it('by default, the API scans nothing', () => {
    assert.deepEqual(scanConfigSchema.parse({}), EMPTY_SCAN_CONFIG);
    assert.deepEqual(parseScanConfig(null), EMPTY_SCAN_CONFIG);
    assert.deepEqual(parseScanConfig({ scanners: ['inconnu'] }), EMPTY_SCAN_CONFIG);
  });

  it('the form ticks everything and blocks on CRITICAL', () => {
    assert.deepEqual(DEFAULT_UI_SCAN_CONFIG.scanners, [...SCANNER_KEYS]);
    assert.equal(DEFAULT_UI_SCAN_CONFIG.failOn, 'CRITICAL');
  });

  it('a partial selection is valid', () => {
    const config = parseScanConfig({ scanners: ['grype'], failOn: 'CRITICAL' });
    assert.deepEqual(config.scanners, ['grype']);
    assert.equal(config.failOn, 'CRITICAL');
  });

  it('a scanner ticked twice only runs once', () => {
    assert.deepEqual(parseScanConfig({ scanners: ['trivy', 'trivy'] }).scanners, ['trivy']);
  });
});

describe('factory', () => {
  it('each vocabulary key has a consistent implementation', () => {
    assert.deepEqual(availableScanners(), [...SCANNER_KEYS]);
    for (const key of SCANNER_KEYS) {
      const scanner = getScanner(key);
      assert.equal(scanner.key, key);
      assert.equal(scanner.kind, SCANNERS[key].kind);
    }
  });

  it('an “sbom” scanner declares a format, a vulnerability scanner does not', () => {
    for (const key of SCANNER_KEYS) {
      const descriptor = SCANNERS[key];
      assert.equal(descriptor.sbomFormat !== null, descriptor.kind === 'sbom');
    }
  });
});

describe('match with the Postgres enums', () => {
  it('round trip over the whole scale', () => {
    for (const severity of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] as Severity[]) {
      assert.equal(severityFromDb(severityToDb(severity)), severity);
    }
  });

  it("`negligible`, inherited from the original schema, is read back as LOW", () => {
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

describe('scanners — where to read the images', () => {
  const docker = { kind: 'docker' } as const;
  const k3s = {
    kind: 'containerd',
    address: '/run/k3s/containerd/containerd.sock',
    namespace: 'k8s.io',
    elevated: true,
  } as const;

  it('on Docker, the three commands stay the ones from before, without elevation', () => {
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

  it('on k3s’s containerd, each tool is pointed there, then falls back on the registry', () => {
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
    // Containerd only knows complete names: Trivy failed under the short name.
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

  it('a containerd open to the user does not ask for sudo', () => {
    const open = { ...k3s, elevated: false };
    const trivy = trivyCommand('x', open, 600_000);
    assert.equal(trivy.sudo, false);
    assert.doesNotMatch(trivy.command, /SUDO_USER/);
  });

  it('under sudo, the tool finds the user’s HOME and keeps its exit code', () => {
    const user = userInfo().username;
    const script = asToolOwner('printf %s "$HOME"; exit 3', '"$HOME"/.inexistant');
    const run = spawnSync('sh', ['-c', script], {
      // What sudo leaves behind: root's HOME, and who called it.
      env: { PATH: process.env.PATH, HOME: '/var/root-de-test', SUDO_USER: user },
      encoding: 'utf8',
    });
    assert.equal(run.status, 3);
    assert.equal(run.stdout, homedir());
  });

  it('without sudo, nothing changes', () => {
    const run = spawnSync('sh', ['-c', asToolOwner('printf %s "$HOME"', '/nulle-part')], {
      env: { PATH: process.env.PATH, HOME: '/maison' },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, '/maison');
  });

  it('the platform follows uname -m', () => {
    const run = spawnSync('sh', ['-c', `echo ${MACHINE_PLATFORM_FLAG}`], { encoding: 'utf8' });
    const arch = ({ x64: 'amd64', arm64: 'arm64' } as Record<string, string>)[process.arch];
    assert.ok(arch, `unexpected test architecture: ${process.arch}`);
    assert.equal(run.stdout.trim(), `--platform linux/${arch}`);
  });
});
