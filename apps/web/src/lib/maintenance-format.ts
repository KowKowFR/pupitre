import { formatDateTimeWith, type FormatSettings } from '@/lib/format';

/**
 * Une date de fenêtre de maintenance : jour court et heure, dans le fuseau de
 * l'instance — le même partout, sur l'écran des maintenances, la vue
 * d'ensemble et les fiches.
 */
export function maintenanceWhen(value: string | Date, format: FormatSettings): string {
  return formatDateTimeWith(value, format, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: format.timezone,
  });
}
