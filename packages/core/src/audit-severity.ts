/**
 * The severity of an activity log entry.
 *
 * It is not written with the entry: it is a **reading** of the action, made at
 * the time one looks. Revising the table therefore reclassifies the whole log,
 * past included, without a migration — and the trace itself stays what it was.
 *
 * - `critical`: to handle now — an SSH fingerprint that changes, a rollback or a
 *   restore that fails;
 * - `high`: an outage, a refusal that looks like an attempt, a gesture on access
 *   (roles, accounts, tokens, integrations);
 * - `medium`: a change of state or configuration, an ordinary failure;
 * - `low`: routine — sign-ins, reads, successes, returns to normal.
 *
 * The same table serves the screen (`auditSeverityOf`) and the database filter
 * (`@pupitre/db` translates it into `CASE … LIKE`): the two cannot diverge.
 */

export const AUDIT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

/**
 * Action pattern and its severity. `*` matches any sequence of characters, dots
 * included; without `*`, the exact action. The first rule that matches wins;
 * none matches: `low`.
 */
export type AuditSeverityRule = readonly [pattern: string, severity: AuditSeverity];

export const AUDIT_SEVERITY_RULES: readonly AuditSeverityRule[] = [
  // Critique.
  ['target.host_key.mismatch', 'critical'],
  ['*.rollback.failed', 'critical'],
  ['backup.restore.failed', 'critical'],

  // High: refusals that look like an attempt…
  ['auth.admin_route.refused', 'high'],
  ['auth.two_factor_route.refused', 'high'],
  ['request.cross_site.refused', 'high'],
  // … gestures on access…
  ['role.*', 'high'],
  ['user.role.changed', 'high'],
  ['user.deleted', 'high'],
  ['user.disabled', 'high'],
  ['user.2fa.reset', 'high'],
  ['account.2fa.disabled', 'high'],
  ['api_token.created', 'high'],
  ['integration.*', 'high'],
  ['target.host_key.accepted', 'high'],
  // … what destroys, bypasses or restores by authority…
  ['target.deleted', 'high'],
  ['deployment.purged', 'high'],
  ['deployment.unblocked', 'high'],
  // An accepted vulnerability no longer blocks: it is a deliberate bypass.
  ['vulnerability.accepted', 'high'],
  ['application.delete.force*', 'high'],
  ['backup.restore*', 'high'],
  ['backup.panel.disabled', 'high'],
  ['workload.exec*', 'high'],
  ['workload.remove*', 'high'],
  // … and outages.
  ['target.unreachable', 'high'],
  ['*.down', 'high'],
  ['deployment.scan.blocked', 'high'],
  ['deployment.rolled_back.automatic', 'high'],
  ['deployment.failed', 'high'],
  ['backup.failed', 'high'],
  ['schedule.run.failed', 'high'],
  ['proxy.install.failed', 'high'],
  ['application.delete.failed', 'high'],

  // Low, despite looking like a change: what one does for oneself.
  ['account.2fa.enabled', 'low'],
  ['account.avatar.*', 'low'],
  ['onboarding.*', 'low'],

  // Medium: ordinary failures and refusals…
  ['*.failed', 'medium'],
  ['*_failed', 'medium'],
  ['*.refused', 'medium'],
  ['*.blocked', 'medium'],
  ['permission.denied', 'medium'],
  ['auth.denied.*', 'medium'],
  // … signals to watch…
  ['target.threshold.breached', 'medium'],
  ['route.certificate.expiring', 'medium'],
  ['audit.exported', 'medium'],
  ['auth.sso.role.kept', 'medium'],
  // … and changes.
  ['auth.signup.succeeded', 'medium'],
  ['auth.password_reset.completed', 'medium'],
  ['account.password.changed', 'medium'],
  ['account.sessions.*', 'medium'],
  ['*.create', 'medium'],
  ['*.created', 'medium'],
  ['*.update', 'medium'],
  ['*.updated', 'medium'],
  ['*.deleted', 'medium'],
  ['*.destroyed', 'medium'],
  ['*.removed', 'medium'],
  ['*.linked', 'medium'],
  ['*.unlinked', 'medium'],
  ['*.connected', 'medium'],
  ['*.installed', 'medium'],
  ['*.enabled', 'medium'],
  ['*.disabled', 'medium'],
  ['*.changed', 'medium'],
  ['*.revoked', 'medium'],
  ['*.invite', 'medium'],
  ['*.invited', 'medium'],
  ['*.set', 'medium'],
  ['*.uploaded', 'medium'],
  ['*.approved', 'medium'],
  ['*.rejected', 'medium'],
  ['*.redeployed', 'medium'],
  ['*.rollback', 'medium'],
  ['*.rolled_back', 'medium'],
  ['*.restarted', 'medium'],
  ['*.started', 'medium'],
  ['*.stopped', 'medium'],
  ['*.install.requested', 'medium'],
  ['*.destroy.requested', 'medium'],
  ['*.delete.requested', 'medium'],
  ['*.deploy.requested', 'medium'],
  ['*.rollback.requested', 'medium'],
  ['*.restart.requested', 'medium'],
  ['*.start.requested', 'medium'],
  ['*.stop.requested', 'medium'],
  ['*.update.requested', 'medium'],
  ['target.host_key.*', 'medium'],
];

const compiled = AUDIT_SEVERITY_RULES.map(([pattern, severity]) => ({
  test: new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  ),
  severity,
}));

/** The severity of a log action. */
export function auditSeverityOf(action: string): AuditSeverity {
  return compiled.find((rule) => rule.test.test(action))?.severity ?? 'low';
}

/**
 * A rule's pattern as SQL `LIKE` (`\` escaping): `_` and `%` are wildcards
 * there, and actions contain them (`auth.two_factor.failed`).
 */
export function auditSeverityLikePattern(pattern: string): string {
  return pattern
    .split('*')
    .map((part) => part.replace(/[\\%_]/g, '\\$&'))
    .join('%');
}

/** `?severity=high,critical`: the recognized severities, in the scale's order. */
export function parseAuditSeverities(value: string | null | undefined): AuditSeverity[] {
  if (!value) return [];
  const wanted = new Set(value.split(',').map((part) => part.trim().toLowerCase()));
  return AUDIT_SEVERITIES.filter((severity) => wanted.has(severity));
}
