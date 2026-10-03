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

describe('failles — corrigeable', () => {
  it('corrigeable quand une version la règle, et seulement alors', () => {
    assert.equal(isFixable(curl('8.14.1-r0')), true);
    assert.equal(isFixable(curl(null)), false);
    assert.equal(isFixable(curl('  ')), false);
    assert.equal(isFixable({ severity: 'HIGH' } as ScannedFinding), false);
  });
});

describe('failles — accepter', () => {
  const accept = (overrides: Partial<VulnerabilityAcceptance> = {}): VulnerabilityAcceptance => ({
    cveId: 'CVE-2026-10536',
    package: 'curl',
    expiresAt: null,
    ...overrides,
  });

  it('couvre la CVE sur son paquet, sans égard à la casse', () => {
    assert.ok(matchingAcceptance(curl(null), [accept({ cveId: 'cve-2026-10536' })], NOW));
    assert.equal(
      matchingAcceptance({ ...curl(null), package: 'libcurl' }, [accept()], NOW),
      null,
      'un autre paquet n’est pas couvert',
    );
  });

  it('« tous les paquets » couvre la CVE partout', () => {
    assert.ok(
      matchingAcceptance({ ...curl(null), package: 'libcurl' }, [accept({ package: null })], NOW),
    );
  });

  it('une acceptation échue ne couvre plus rien', () => {
    assert.equal(
      matchingAcceptance(curl(null), [accept({ expiresAt: '2026-10-01T00:00:00Z' })], NOW),
      null,
    );
    assert.ok(matchingAcceptance(curl(null), [accept({ expiresAt: '2026-12-01T00:00:00Z' })], NOW));
  });

  it('exige un motif, et une échéance raisonnable ou aucune', () => {
    const base = { cveId: 'CVE-1', package: 'curl', reason: 'jamais appelé', expiresInDays: 90 };
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

describe('failles — ce qui bloque', () => {
  it('le seuil seul : une CRITICAL bloque, corrigeable ou non', () => {
    assert.ok(findingBlocks(curl(null), policy()));
    assert.ok(findingBlocks(curl('8.14.1-r0'), policy()));
  });

  it('seulement les corrigeables : la faille sans correctif ne bloque plus', () => {
    assert.ok(!findingBlocks(curl(null), policy({ onlyFixable: true })));
    assert.ok(findingBlocks(curl('8.14.1-r0'), policy({ onlyFixable: true })));
  });

  it('une faille acceptée ne bloque plus, même corrigeable', () => {
    const accepted = policy({
      acceptances: [{ cveId: 'CVE-2026-10536', package: 'curl', expiresAt: null }],
    });
    assert.ok(!findingBlocks(curl('8.14.1-r0'), accepted));
  });

  it('sous le seuil, rien ne bloque', () => {
    assert.ok(!findingBlocks({ ...curl('1.0'), severity: 'HIGH' }, policy()));
  });

  it('le verdict suit la politique entière ; un seuil seul reste compris', () => {
    const findings = [curl(null), { ...curl('1.0'), cveId: 'CVE-2', severity: 'HIGH' as const }];
    assert.equal(verdictFor('vulnerability', findings, 'CRITICAL'), 'fail');
    assert.equal(verdictFor('vulnerability', findings, policy({ onlyFixable: true })), 'pass');
    assert.equal(verdictFor('sbom', findings, policy()), 'pass');
  });

  it('le résumé compte corrigeables, acceptées et bloquantes', () => {
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

describe('failles — le réglage de l’application', () => {
  const config = { scanners: ['trivy' as const], failOn: 'NONE' as const, onlyFixable: false };

  it('ce qui est réglé l’emporte, ce qui ne l’est pas suit l’instance', () => {
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

  it('sans scanner, un seuil n’a rien pour l’évaluer : rien ne change', () => {
    const none = { scanners: [], failOn: 'NONE' as const, disabledBy: 'settings' as const };
    assert.deepEqual(withApplicationScanPolicy(none, { failOn: 'HIGH', onlyFixable: true }), none);
  });
});

describe('failles — le réglage de l’instance', () => {
  it('par défaut, toutes les failles comptent', () => {
    assert.equal(securitySettingsSchema.parse({}).onlyFixable, false);
  });

  it('un patch qui n’en parle pas n’y touche pas', () => {
    assert.deepEqual(securitySettingsPatchSchema.parse({ failOn: 'HIGH' }), { failOn: 'HIGH' });
  });

  it('la politique de l’instance porte la règle des corrigeables', () => {
    const security = securitySettingsSchema.parse({ failOn: 'CRITICAL', onlyFixable: true });
    assert.equal(scanConfigFromSettings(security).onlyFixable, true);
  });

  it('une demande explicite qui la tait suit l’instance ; dite, elle compte', () => {
    const security = securitySettingsSchema.parse({ failOn: 'CRITICAL', onlyFixable: true });
    const asked = { scanners: ['grype' as const], failOn: 'HIGH' as const };
    assert.equal(applySecuritySettings(asked, security).onlyFixable, true);
    assert.equal(
      applySecuritySettings({ ...asked, onlyFixable: false }, security).onlyFixable,
      false,
    );
  });
});

describe('failles — le journal et le temps réel', () => {
  it('accepter une faille est un contournement : gravité élevée', () => {
    assert.equal(auditSeverityOf('vulnerability.accepted'), 'high');
    assert.equal(auditSeverityOf('vulnerability.acceptance.removed'), 'medium');
    assert.equal(auditSeverityOf('application.scan_policy.changed'), 'medium');
  });

  it('une acceptation se lit dans la fiche de l’application', () => {
    assert.equal(liveTopicOfResource('vulnerability_acceptance'), 'applications');
  });
});
