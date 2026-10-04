/**
 * The two gestures every command sent to a machine shares.
 *
 * A single copy, tested: `shellQuote` protects each value that goes into a
 * remote command — a path, a container name, a label. A copy that diverged one
 * day would be enough to open an injection; there were eleven.
 */

/** A value between single quotes, ready for `sh`: nothing in it is interpreted. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The first non-empty line of an output, trimmed; `null` if there is none. */
export function firstLine(text: string): string | null {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0);
  return line?.trim() ?? null;
}
