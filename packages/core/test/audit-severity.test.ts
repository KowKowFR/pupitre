import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AUDIT_SEVERITY_RULES,
  auditSeverityLikePattern,
  auditSeverityOf,
  parseAuditSeverities,
  type AuditSeverity,
} from '../src/audit-severity.js';

describe('log severity', () => {
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

  it("a dot in the pattern is not a wildcard", () => {
    // `*.down` must not match `breakdown`: the dot is literal.
    assert.equal(auditSeverityOf('monitor.breakdown'), 'low');
  });

  it('translates a pattern into LIKE, SQL wildcards escaped', () => {
    assert.equal(auditSeverityLikePattern('auth.two_factor.failed'), 'auth.two\\_factor.failed');
    assert.equal(auditSeverityLikePattern('*.rollback.failed'), '%.rollback.failed');
    assert.equal(auditSeverityLikePattern('100%'), '100\\%');
  });

  it("each SQL pattern matches the same actions as the screen", () => {
    // Simulated `LIKE`: `%` matches anything, `\x` matches `x`.
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

  it('reads the query’s list', () => {
    assert.deepEqual(parseAuditSeverities('critical,HIGH, inconnu'), ['high', 'critical']);
    assert.deepEqual(parseAuditSeverities(''), []);
    assert.deepEqual(parseAuditSeverities(null), []);
  });
});
