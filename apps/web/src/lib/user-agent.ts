/**
 * « Firefox 131 · Linux » à partir d'un en-tête `User-Agent`.
 *
 * Juste de quoi reconnaître un appareil dans la liste des sessions : le
 * navigateur, sa version majeure, le système. Pas de base de données
 * d'agents — une session se reconnaît à ces trois mots, et un agent inconnu
 * (`curl/8.4.0`, un script) est montré par son premier jeton plutôt qu'en
 * entier.
 *
 * L'ordre des navigateurs compte : Edge et Opera s'annoncent aussi comme
 * Chrome, et Chrome comme Safari.
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
