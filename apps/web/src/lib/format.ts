import type { AppSettings, DateStyleName } from '@pupitre/core';

/**
 * Formatting dates **and numbers**, from the instance settings.
 *
 * No `'server-only'` here: `targets-view.tsx` is a *client* component,
 * `audit-table.tsx` a *server* component, and both must show the same string for
 * the same date. That is also why the time zone is always explicit and never the
 * browser's — an `Intl.DateTimeFormat` without `timeZone` would render "14:32" on
 * the server side (UTC in the container) and "15:32" on the client side
 * (Europe/Paris), and Next would report a hydration error at the first table of
 * dates.
 *
 * **Passed down through props, not through a React context.** A context set in
 * `(app)/layout.tsx` would be shorter to write, but a context is only readable
 * from a client component: `audit-table.tsx`, which is rendered on the server,
 * could not use it, and it would have to be converted into a client component
 * for the sole reason of showing a date. Props cross both worlds without
 * converting anything.
 *
 * **Numbers follow exactly the same rule, and for the same reason.** `1 234,5` in
 * French, `1,234.5` in English: it is the instance's locale that decides, never
 * `navigator.language`, never `undefined`. A `toLocaleString()` without a locale
 * takes the browser's on the client side and the container's on the server side
 * — two different strings for the same number, and Next reports a hydration
 * error. The locale therefore travels in `FormatSettings`, next to the time zone,
 * and both worlds read the same value.
 *
 * `settings.locale` is used **as is** (`fr-FR`, `en-GB`) and never reduced to its
 * first two letters: `en-GB` and `en-US` do not write the same date, and nothing
 * guarantees that `Intl` renders for `fr` what it renders for `fr-FR`.
 */

export type FormatSettings = {
  timezone: string;
  locale: string;
  dateStyle: DateStyleName;
  timeStyle: DateStyleName;
};

/** Extracts what it takes to format from the complete settings. */
export function formatSettingsOf(settings: AppSettings): FormatSettings {
  return {
    timezone: settings.timezone,
    locale: settings.locale,
    dateStyle: settings.dateStyle,
    timeStyle: settings.timeStyle,
  };
}

/**
 * Building an `Intl.DateTimeFormat` costs more than using it: we keep the
 * instances, indexed by their configuration. The number of combinations is
 * bounded by the settings, never by the data.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(settings: FormatSettings): Intl.DateTimeFormat {
  const key = `${settings.locale}|${settings.timezone}|${settings.dateStyle}|${settings.timeStyle}`;
  const cached = formatters.get(key);
  if (cached) return cached;

  const created = new Intl.DateTimeFormat(settings.locale, {
    dateStyle: settings.dateStyle,
    timeStyle: settings.timeStyle,
    timeZone: settings.timezone,
  });
  formatters.set(key, created);
  return created;
}

export type DateInput = Date | string | number | null | undefined;

/**
 * Formats a date. `null` returns the fallback text rather than an exception:
 * "never tested", "no run" are normal cases, not errors.
 */
export function formatDateTime(
  value: DateInput,
  settings: FormatSettings,
  fallback = '—',
): string {
  if (value === null || value === undefined || value === '') return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return formatterFor(settings).format(date);
}

/** A pre-bound formatter, for the components that show many dates. */
export function createDateFormatter(
  settings: FormatSettings,
  fallback = '—',
): (value: DateInput) => string {
  return (value) => formatDateTime(value, settings, fallback);
}

/**
 * Formats a date with components chosen by the caller.
 *
 * Not all of the panel's dates read with `dateStyle`/`timeStyle`: a chart axis
 * only writes the hour and minute, a strip only the day and hour. These figures
 * therefore keep their options — it is their layout that imposes them —, but
 * they have no reason to keep their locale.
 *
 * The `timeZone` is **not** imposed here: some callers pin it (a deployment's
 * timestamp reads in UTC, deliberately), others follow the instance. Each one
 * says so in its options.
 */
export function formatDateTimeWith(
  value: DateInput,
  settings: FormatSettings,
  options: Intl.DateTimeFormatOptions,
  fallback = '—',
): string {
  if (value === null || value === undefined || value === '') return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return partsFormatterFor(settings.locale, options).format(date);
}

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatterFor(
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  const cached = partFormatters.get(key);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat(locale, options);
  partFormatters.set(key, created);
  return created;
}

/**
 * Numbers, in the instance's locale.
 *
 * The same cache and the same reason as for dates: building an `Intl.NumberFormat`
 * costs more than using it, and the number of combinations is bounded by the
 * callers.
 */
const numberFormatters = new Map<string, Intl.NumberFormat>();

function numberFormatterFor(
  locale: string,
  options: Intl.NumberFormatOptions | undefined,
): Intl.NumberFormat {
  const key = `${locale}|${options ? JSON.stringify(options) : ''}`;
  const cached = numberFormatters.get(key);
  if (cached) return cached;
  const created = new Intl.NumberFormat(locale, options);
  numberFormatters.set(key, created);
  return created;
}

/**
 * Formats a number. Without options, it is exactly what
 * `value.toLocaleString(locale)` returned — thousands separator included.
 */
export function formatNumber(
  value: number,
  settings: FormatSettings,
  options?: Intl.NumberFormatOptions,
): string {
  return numberFormatterFor(settings.locale, options).format(value);
}
