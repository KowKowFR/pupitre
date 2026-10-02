import type { Translate } from '@pupitre/core';
import type { settings } from '@/i18n/messages/settings';

/** La raison d'une connexion unique indisponible, dite dans la langue de l'instance. */
export function describeSsoProblem(
  problem: { code: string; detail: string | null },
  t: Translate<typeof settings.fr>,
): string {
  switch (problem.code) {
    case 'missing':
      return t('sso.problem.missing');
    case 'http':
      return t('sso.problem.http', { detail: problem.detail ?? '?' });
    case 'issuer':
      return t('sso.problem.issuer', { detail: problem.detail ?? '?' });
    case 'incomplete':
      return t('sso.problem.incomplete', { detail: problem.detail ?? '?' });
    case 'unreachable':
      return t('sso.problem.unreachable', { detail: problem.detail ?? '?' });
    default:
      return t('sso.problem.unreadable');
  }
}
