import type { Translate } from '@pupitre/core';
import type { common } from '@/i18n/messages/common';

/**
 * « il y a 27 min ». Le calcul se fait côté serveur, au rendu : un composant
 * client qui lirait l'horloge pendant son rendu ne donnerait pas la même
 * chaîne que le serveur, et React le signalerait à l'hydratation.
 */
export function relativeTime(
  date: Date | string | null,
  t: Translate<typeof common.fr>,
  now: number = Date.now(),
): string | null {
  if (date === null) return null;
  const then = typeof date === 'string' ? Date.parse(date) : date.getTime();
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 10) return t('ago.now');
  if (seconds < 60) return t('ago.seconds', { count: seconds });
  if (seconds < 3600) return t('ago.minutes', { count: Math.floor(seconds / 60) });
  if (seconds < 86_400) return t('ago.hours', { count: Math.floor(seconds / 3600) });
  return t('ago.days', { count: Math.floor(seconds / 86_400) });
}
