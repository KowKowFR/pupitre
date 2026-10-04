/**
 * "Firefox 131 · Linux" from a `User-Agent` header.
 *
 * Just enough to recognize a device in the sessions list: the browser, its major
 * version, the system. No database of agents — a session is recognized by these
 * three words, and an unknown agent (`curl/8.4.0`, a script) is shown by its first
 * token rather than in full.
 *
 * The browsers' order matters: Edge and Opera also announce themselves as Chrome,
 * and Chrome as Safari.
 */
const BROWSERS: ReadonlyArray<[RegExp, string]> = [
  [/Edg(?:e|A|iOS)?\/(\d+)/, 'Edge'],
  [/OPR\/(\d+)/, 'Opera'],
  [/(?:Firefox|FxiOS)\/(\d+)/, 'Firefox'],
  [/(?:Chrome|CriOS)\/(\d+)/, 'Chrome'],
  [/Version\/(\d+)[\d.]*(?: Mobile\/\S+)? Safari\//, 'Safari'],
];

const SYSTEMS: ReadonlyArray<[RegExp, string]> = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/Windows/, 'Windows'],
  [/CrOS/, 'ChromeOS'],
  [/Macintosh|Mac OS X/, 'macOS'],
  [/Linux/, 'Linux'],
];

export function describeUserAgent(userAgent: string | null | undefined): string | null {
  const agent = userAgent?.trim() ?? '';
  if (agent === '') return null;

  let browser: string | null = null;
  for (const [pattern, name] of BROWSERS) {
    const match = pattern.exec(agent);
    if (match) {
      browser = `${name} ${match[1]}`;
      break;
    }
  }
  const system = SYSTEMS.find(([pattern]) => pattern.test(agent))?.[1] ?? null;

  if (browser === null) {
    const first = agent.split(/\s+/)[0] ?? agent;
    return first.length > 40 ? `${first.slice(0, 39)}…` : first;
  }
  return system ? `${browser} · ${system}` : browser;
}
