import type { Translate } from '@pupitre/core';
import type { common } from '@/i18n/messages/common';

/**
 * "27 min ago". The computation is done on the server side, at render time: a
 * client component that read the clock during its render would not give the same
 * string as the server, and React would report it at hydration.
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
