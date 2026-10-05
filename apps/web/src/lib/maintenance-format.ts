import { formatDateTimeWith, type FormatSettings } from '@/lib/format';

/**
 * A maintenance window's date: short day and time, in the instance's time zone —
 * the same everywhere, on the maintenance screen, the overview and the records.
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
