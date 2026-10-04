import 'server-only';
import type { PublicTarget } from '@pupitre/db';

/**
 * A target's projection for the audit log.
 *
 * `PublicTarget` already carries no credential — the SQL query does not select
 * the column. This function reduces the noise further and serves as a single
 * point if a sensitive field were ever added to the model.
 */
export function auditableTarget(target: PublicTarget): Record<string, unknown> {
  return {
    name: target.name,
    description: target.description,
    host: target.host,
    port: target.port,
    sshUser: target.sshUser,
    authMethod: target.authMethod,
    sudoMethod: target.sudoMethod,
    labels: target.labels,
    portRange: `${target.portRangeStart}-${target.portRangeEnd}`,
    status: target.status,
  };
}
