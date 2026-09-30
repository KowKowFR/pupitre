/**
 * Les jours d'un filtre « Du … Au … », lus dans le fuseau de l'instance.
 *
 * Un champ de date rend `2026-09-30`. Converti tel quel, c'est minuit UTC :
 * « Au 30/09 » excluait alors toute la journée du 30, et à Paris les deux
 * premières heures du 29 tombaient du mauvais côté. On lit donc le jour comme
 * l'écran l'affiche — dans le fuseau réglé — et « Au » couvre la journée
 * entière. Une valeur qui porte déjà une heure (un appel d'API en ISO 8601)
 * est laissée telle quelle : elle dit exactement ce qu'elle veut.
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Écart du fuseau avec UTC à un instant donné, en millisecondes. */
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
 * Minuit du jour `day` dans le fuseau `timeZone`, en instant UTC.
 *
 * L'écart est relu à l'instant trouvé : un jour de changement d'heure, celui
 * de minuit UTC n'est pas forcément celui de minuit local. Un fuseau inconnu
 * retombe sur UTC plutôt que de lever.
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
 * Remplace `from` et `to`, quand ce sont des jours, par les instants qui
 * bornent ces jours dans le fuseau : le début du premier, la dernière
 * milliseconde du second. Les autres paramètres passent sans changement.
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
