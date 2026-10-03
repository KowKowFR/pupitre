/**
 * La criticité d'une entrée du journal d'activité.
 *
 * Elle ne s'écrit pas avec l'entrée : c'est une **lecture** de l'action, faite
 * au moment où l'on regarde. Revoir la table reclasse donc tout le journal,
 * passé compris, sans migration — et la trace elle-même reste ce qu'elle était.
 *
 * - `critical` : à traiter maintenant — une empreinte SSH qui change, un retour
 *   arrière ou une restauration qui échoue ;
 * - `high` : une panne, un refus qui ressemble à une tentative, un geste sur
 *   les accès (rôles, comptes, jetons, intégrations) ;
 * - `medium` : un changement d'état ou de configuration, un échec ordinaire ;
 * - `low` : la routine — connexions, lectures, réussites, retours à la normale.
 *
 * La même table sert l'écran (`auditSeverityOf`) et le filtre en base
 * (`@pupitre/db` la traduit en `CASE … LIKE`) : les deux ne peuvent pas
 * diverger.
 */

export const AUDIT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

/**
 * Motif d'action et sa criticité. `*` vaut n'importe quelle suite de
 * caractères, points compris ; sans `*`, l'action exacte. La première règle
 * qui répond l'emporte ; aucune ne répond : `low`.
 */
export type AuditSeverityRule = readonly [pattern: string, severity: AuditSeverity];

export const AUDIT_SEVERITY_RULES: readonly AuditSeverityRule[] = [
  // Critique.
  ['target.host_key.mismatch', 'critical'],
  ['*.rollback.failed', 'critical'],
  ['backup.restore.failed', 'critical'],

  // Élevée : les refus qui ressemblent à une tentative…
  ['auth.admin_route.refused', 'high'],
  ['auth.two_factor_route.refused', 'high'],
  ['request.cross_site.refused', 'high'],
  // … les gestes sur les accès…
  ['role.*', 'high'],
  ['user.role.changed', 'high'],
  ['user.deleted', 'high'],
  ['user.disabled', 'high'],
  ['user.2fa.reset', 'high'],
  ['account.2fa.disabled', 'high'],
  ['api_token.created', 'high'],
  ['integration.*', 'high'],
  ['target.host_key.accepted', 'high'],
  // … ce qui détruit, contourne ou rétablit d'autorité…
  ['target.deleted', 'high'],
  ['deployment.purged', 'high'],
  ['deployment.unblocked', 'high'],
  // Une faille acceptée ne bloque plus : c'est un contournement assumé.
  ['vulnerability.accepted', 'high'],
  ['application.delete.force*', 'high'],
  ['backup.restore*', 'high'],
  ['backup.panel.disabled', 'high'],
  ['workload.exec*', 'high'],
  ['workload.remove*', 'high'],
  // … et les pannes.
  ['target.unreachable', 'high'],
  ['*.down', 'high'],
  ['deployment.scan.blocked', 'high'],
  ['deployment.rolled_back.automatic', 'high'],
  ['deployment.failed', 'high'],
  ['backup.failed', 'high'],
  ['schedule.run.failed', 'high'],
  ['proxy.install.failed', 'high'],
  ['application.delete.failed', 'high'],

  // Faible, malgré la forme d'un changement : ce qu'on fait pour soi.
  ['account.2fa.enabled', 'low'],
  ['account.avatar.*', 'low'],
  ['onboarding.*', 'low'],

  // Moyenne : les échecs et refus ordinaires…
  ['*.failed', 'medium'],
  ['*_failed', 'medium'],
  ['*.refused', 'medium'],
  ['*.blocked', 'medium'],
  ['permission.denied', 'medium'],
  ['auth.denied.*', 'medium'],
  // … les signaux à surveiller…
  ['target.threshold.breached', 'medium'],
  ['route.certificate.expiring', 'medium'],
  ['audit.exported', 'medium'],
  ['auth.sso.role.kept', 'medium'],
  // … et les changements.
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

/** La criticité d'une action du journal. */
export function auditSeverityOf(action: string): AuditSeverity {
  return compiled.find((rule) => rule.test.test(action))?.severity ?? 'low';
}

/**
 * Le motif d'une règle en `LIKE` SQL (échappement `\`) : `_` et `%` y sont
 * des jokers, et les actions en contiennent (`auth.two_factor.failed`).
 */
export function auditSeverityLikePattern(pattern: string): string {
  return pattern
    .split('*')
    .map((part) => part.replace(/[\\%_]/g, '\\$&'))
    .join('%');
}

/** `?severity=high,critical` : les criticités reconnues, dans l'ordre de l'échelle. */
export function parseAuditSeverities(value: string | null | undefined): AuditSeverity[] {
  if (!value) return [];
  const wanted = new Set(value.split(',').map((part) => part.trim().toLowerCase()));
  return AUDIT_SEVERITIES.filter((severity) => wanted.has(severity));
}
