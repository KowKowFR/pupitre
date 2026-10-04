/**
 * The exports' CSV, separate from `export.ts` because it is pure: it is tested
 * without a server, and `export.ts` only loads on the server side.
 */

/**
 * A CSV cell (RFC 4180), neutralized against formula injection.
 *
 * The file will end up in a spreadsheet. A value starting with `=`, `+`, `-`,
 * `@`, a tab or a carriage return would be executed there as a formula — and a
 * deployment error message comes from a remote machine, hence from anyone. We
 * prefix it with an apostrophe, which the spreadsheet does not show.
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A CSV line, CRLF line ending as RFC 4180 wants it. */
export function csvRow(cells: ReadonlyArray<string | number | boolean | null | undefined>): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}
