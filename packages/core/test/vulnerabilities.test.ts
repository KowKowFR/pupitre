import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applySecuritySettings,
  auditSeverityOf,
  createVulnerabilityAcceptanceSchema,
  findingBlocks,
  isFixable,
  liveTopicOfResource,
  matchingAcceptance,
  scanConfigFromSettings,
  securitySettingsPatchSchema,
  securitySettingsSchema,
  summarizeFindings,
  verdictFor,
  withApplicationScanPolicy,
  type ScanPolicy,
  type ScannedFinding,
  type VulnerabilityAcceptance,
} from '../src/index.js';

const NOW = new Date('2026-10-03T12:00:00Z');

const curl = (fix: string | null): ScannedFinding => ({
  cveId: 'CVE-2026-10536',
  severity: 'CRITICAL',
  package: 'curl',
  fixedVersion: fix,
});

const policy = (overrides: Partial<ScanPolicy> = {}): ScanPolicy => ({
  failOn: 'CRITICAL',
  onlyFixable: false,
  acceptances: [],
  now: NOW,
  ...overrides,
});

describe('vulnerabilities — fixable', () => {
  it('fixable when a version fixes it, and only then', () => {
    assert.equal(isFixable(curl('8.14.1-r0')), true);
    assert.equal(isFixable(curl(null)), false);
    assert.equal(isFixable(curl('  ')), false);
    assert.equal(isFixable({ severity: 'HIGH' } as ScannedFinding), false);
  });
});

describe('vulnerabilities — accepting', () => {
  const accept = (overrides: Partial<VulnerabilityAcceptance> = {}): VulnerabilityAcceptance => ({
    cveId: 'CVE-2026-10536',
    package: 'curl',
    expiresAt: null,
    ...overrides,
  });

  it('covers the CVE on its package, case-insensitively', () => {
    assert.ok(matchingAcceptance(curl(null), [accept({ cveId: 'cve-2026-10536' })], NOW));
    assert.equal(
      matchingAcceptance({ ...curl(null), package: 'libcurl' }, [accept()], NOW),
      null,
      'another package is not covered',
    );
  });

  it('“all packages” covers the CVE everywhere', () => {
    assert.ok(
      matchingAcceptance({ ...curl(null), package: 'libcurl' }, [accept({ package: null })], NOW),
    );
  });

  it('an expired acceptance no longer covers anything', () => {
    assert.equal(
      matchingAcceptance(curl(null), [accept({ expiresAt: '2026-10-01T00:00:00Z' })], NOW),
      null,
    );
    assert.ok(matchingAcceptance(curl(null), [accept({ expiresAt: '2026-12-01T00:00:00Z' })], NOW));
  });

  it('requires a reason, and a reasonable expiry or none', () => {
    const base = { cveId: 'CVE-1', package: 'curl', reason: 'never called', expiresInDays: 90 };
    assert.ok(createVulnerabilityAcceptanceSchema.safeParse(base).success);
    assert.ok(
      createVulnerabilityAcceptanceSchema.safeParse({ ...base, expiresInDays: null }).success,
    );
    assert.ok(!createVulnerabilityAcceptanceSchema.safeParse({ ...base, reason: ' x ' }).success);
    assert.ok(
      !createVulnerabilityAcceptanceSchema.safeParse({ ...base, expiresInDays: 0 }).success,
    );
  });
});

describe('vulnerabilities — what blocks', () => {
  it('the threshold alone: a CRITICAL blocks, fixable or not', () => {
    assert.ok(findingBlocks(curl(null), policy()));
    assert.ok(findingBlocks(curl('8.14.1-r0'), policy()));
  });

  it('only the fixable ones: the vulnerability without a fix no longer blocks', () => {
    assert.ok(!findingBlocks(curl(null), policy({ onlyFixable: true })));
    assert.ok(findingBlocks(curl('8.14.1-r0'), policy({ onlyFixable: true })));
  });

  it('an accepted vulnerability no longer blocks, even fixable', () => {
    const accepted = policy({
      acceptances: [{ cveId: 'CVE-2026-10536', package: 'curl', expiresAt: null }],
    });
    assert.ok(!findingBlocks(curl('8.14.1-r0'), accepted));
  });

  it('under the threshold, nothing blocks', () => {
    assert.ok(!findingBlocks({ ...curl('1.0'), severity: 'HIGH' }, policy()));
  });

  it('the verdict follows the whole policy; a threshold alone is still understood', () => {
    const findings = [curl(null), { ...curl('1.0'), cveId: 'CVE-2', severity: 'HIGH' as const }];
    assert.equal(verdictFor('vulnerability', findings, 'CRITICAL'), 'fail');
    assert.equal(verdictFor('vulnerability', findings, policy({ onlyFixable: true })), 'pass');
    assert.equal(verdictFor('sbom', findings, policy()), 'pass');
  });

  it('the summary counts fixable, accepted and blocking', () => {
    const findings = [
      curl('8.14.1-r0'),
      { ...curl(null), cveId: 'CVE-2' },
      { ...curl(null), cveId: 'CVE-3', severity: 'LOW' as const },
    ];
    assert.deepEqual(
      summarizeFindings(
        findings,
        policy({ acceptances: [{ cveId: 'CVE-2', package: null, expiresAt: null }] }),
      ),
      { total: 3, fixable: 1, accepted: 1, blocking: 1 },
    );
  });
});

describe('vulnerabilities — the application’s setting', () => {
  const config = { scanners: ['trivy' as const], failOn: 'NONE' as const, onlyFixable: false };

  it('what is set wins, what is not follows the instance', () => {
    assert.deepEqual(
      withApplicationScanPolicy(config, { failOn: null, onlyFixable: null }),
      config,
    );
    assert.deepEqual(withApplicationScanPolicy(config, { failOn: 'CRITICAL', onlyFixable: null }), {
      ...config,
      failOn: 'CRITICAL',
    });
    assert.deepEqual(withApplicationScanPolicy(config, { failOn: null, onlyFixable: true }), {
      ...config,
      onlyFixable: true,
    });
  });

  it('without a scanner, a threshold has nothing to evaluate it: nothing changes', () => {
    const none = { scanners: [], failOn: 'NONE' as const, disabledBy: 'settings' as const };
    assert.deepEqual(withApplicationScanPolicy(none, { failOn: 'HIGH', onlyFixable: true }), none);
  });
});

describe('vulnerabilities — the instance’s setting', () => {
  it('by default, every vulnerability counts', () => {
    assert.equal(securitySettingsSchema.parse({}).onlyFixable, false);
  });

  it('a patch that does not mention it does not touch it', () => {
    assert.deepEqual(securitySettingsPatchSchema.parse({ failOn: 'HIGH' }), { failOn: 'HIGH' });
  });

  it('the instance’s policy carries the fixable rule', () => {
    const security = securitySettingsSchema.parse({ failOn: 'CRITICAL', onlyFixable: true });
    assert.equal(scanConfigFromSettings(security).onlyFixable, true);
  });

  it('an explicit request that leaves it out follows the instance; stated, it counts', () => {
    const security = securitySettingsSchema.parse({ failOn: 'CRITICAL', onlyFixable: true });
    const asked = { scanners: ['grype' as const], failOn: 'HIGH' as const };
    assert.equal(applySecuritySettings(asked, security).onlyFixable, true);
    assert.equal(
      applySecuritySettings({ ...asked, onlyFixable: false }, security).onlyFixable,
      false,
    );
  });
});

describe('vulnerabilities — the log and real time', () => {
  it('accepting a vulnerability is a bypass: high severity', () => {
    assert.equal(auditSeverityOf('vulnerability.accepted'), 'high');
    assert.equal(auditSeverityOf('vulnerability.acceptance.removed'), 'medium');
    assert.equal(auditSeverityOf('application.scan_policy.changed'), 'medium');
  });

  it('an acceptance is read in the application’s record', () => {
    assert.equal(liveTopicOfResource('vulnerability_acceptance'), 'applications');
  });
});
