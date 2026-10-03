import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AUDIT_SEVERITY_RULES,
  auditSeverityLikePattern,
  auditSeverityOf,
  parseAuditSeverities,
  type AuditSeverity,
} from '../src/audit-severity.js';

describe('criticité du journal', () => {
  const cases: Array<[string, AuditSeverity]> = [
    ['target.host_key.mismatch', 'critical'],
    ['deployment.rollback.failed', 'critical'],
    ['backup.restore.failed', 'critical'],
    ['auth.admin_route.refused', 'high'],
    ['request.cross_site.refused', 'high'],
    ['role.updated', 'high'],
    ['user.role.changed', 'high'],
    ['api_token.created', 'high'],
    ['integration.gitea.token_replaced', 'high'],
    ['target.host_key.accepted', 'high'],
    ['backup.restored', 'high'],
    ['workload.exec', 'high'],
    ['monitor.down', 'high'],
    ['route.down', 'high'],
    ['deployment.failed', 'high'],
    ['deployment.scan.blocked', 'high'],
    ['auth.login.failed', 'medium'],
    ['auth.two_factor.failed', 'medium'],
    ['account.password.change_failed', 'medium'],
    ['permission.denied', 'medium'],
    ['auth.signup.blocked', 'medium'],
    ['workload.update.refused', 'medium'],
    ['deployment.created', 'medium'],
    ['settings.updated', 'medium'],
    ['source_archive.uploaded', 'medium'],
    ['target.host_key.dismissed', 'medium'],
    ['account.2fa.enabled', 'low'],
    ['onboarding.step.completed', 'low'],
    ['auth.login.succeeded', 'low'],
    ['deployment.succeeded', 'low'],
    ['schedule.run.succeeded', 'low'],
    ['target.preflight.requested', 'low'],
    ['monitor.recovered', 'low'],
    ['une.action.inconnue', 'low'],
  ];

  for (const [action, severity] of cases) {
    it(`${action} → ${severity}`, () => {
      assert.equal(auditSeverityOf(action), severity);
    });
  }

  it("un point du motif n'est pas un joker", () => {
    // `*.down` ne doit pas répondre à `breakdown` : le point est littéral.
    assert.equal(auditSeverityOf('monitor.breakdown'), 'low');
  });

  it('traduit un motif en LIKE, jokers SQL échappés', () => {
    assert.equal(auditSeverityLikePattern('auth.two_factor.failed'), 'auth.two\\_factor.failed');
    assert.equal(auditSeverityLikePattern('*.rollback.failed'), '%.rollback.failed');
    assert.equal(auditSeverityLikePattern('100%'), '100\\%');
  });

  it("chaque motif SQL répond aux mêmes actions que l'écran", () => {
    // `LIKE` simulé : `%` vaut n'importe quoi, `\x` vaut `x`.
    const like = (pattern: string, value: string) => {
      let source = '';
      for (let index = 0; index < pattern.length; index += 1) {
        const char = pattern[index]!;
        if (char === '\\') source += pattern[++index]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        else if (char === '%') source += '.*';
        else if (char === '_') source += '.';
        else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      return new RegExp(`^${source}$`).test(value);
    };
    for (const [action] of cases) {
      const sql =
        AUDIT_SEVERITY_RULES.find(([pattern]) =>
          like(auditSeverityLikePattern(pattern), action),
        )?.[1] ?? 'low';
      assert.equal(sql, auditSeverityOf(action), action);
    }
  });

  it('lit la liste de la requête', () => {
    assert.deepEqual(parseAuditSeverities('critical,HIGH, inconnu'), ['high', 'critical']);
    assert.deepEqual(parseAuditSeverities(''), []);
    assert.deepEqual(parseAuditSeverities(null), []);
  });
});
