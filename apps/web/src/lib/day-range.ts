/**
 * The days of a "From … To …" filter, read in the instance's time zone.
 *
 * A date field returns `2026-09-30`. Converted as is, it is midnight UTC: "To
 * 30/09" then excluded the whole day of the 30th, and in Paris the first two
 * hours of the 29th fell on the wrong side. So we read the day as the screen
 * shows it — in the set time zone — and "To" covers the whole day. A value that
 * already carries a time (an API call in ISO 8601) is left as is: it says exactly
 * what it wants.
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The time zone's offset from UTC at a given instant, in milliseconds. */
function offsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value);
  const local = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return local - Math.floor(instant / 1000) * 1000;
}

/**
 * Midnight of day `day` in time zone `timeZone`, as a UTC instant.
 *
 * The offset is read again at the found instant: on a daylight saving day, the
 * offset at midnight UTC is not necessarily the one at local midnight. An unknown
 * time zone falls back on UTC rather than throwing.
 */
export function zonedDayStart(day: string, timeZone: string): Date | null {
  const match = DATE_ONLY.exec(day);
  if (!match) return null;
  const midnightUtc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  try {
    const first = midnightUtc - offsetMs(midnightUtc, timeZone);
    return new Date(midnightUtc - offsetMs(first, timeZone));
  } catch {
    return new Date(midnightUtc);
  }
}

/**
 * Replaces `from` and `to`, when they are days, with the instants that bound those
 * days in the time zone: the start of the first, the last millisecond of the
 * second. The other parameters go through unchanged.
 */
export function expandDayRange(
  params: Record<string, string>,
  timeZone: string,
): Record<string, string> {
  const out = { ...params };
  if (params.from) {
    const start = zonedDayStart(params.from, timeZone);
    if (start) out.from = start.toISOString();
  }
  if (params.to && DATE_ONLY.test(params.to)) {
    const [year, month, day] = params.to.split('-').map(Number) as [number, number, number];
    const next = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
    const end = zonedDayStart(next, timeZone);
    if (end) out.to = new Date(end.getTime() - 1).toISOString();
  }
  return out;
}
