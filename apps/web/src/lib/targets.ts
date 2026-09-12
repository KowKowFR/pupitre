import 'server-only';
import type { PublicTarget } from '@pupitre/db';

/**
 * Projection d'une cible pour le journal d'audit.
 *
 * `PublicTarget` ne porte déjà pas de credential — la requête SQL ne
 * sélectionne pas la colonne. Cette fonction réduit encore le bruit et sert de
 * point unique si un champ sensible venait à être ajouté au modèle.
 */
export function auditableTarget(target: PublicTarget): Record<string, unknown> {
  return {
    name: target.name,
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
