import type { Translate } from '@pupitre/core';
import type { settings } from '@/i18n/messages/settings';

/** The reason single sign-on is unavailable, said in the instance's language. */
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
