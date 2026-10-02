/**
 * Les deux gestes que partage toute commande envoyée à une machine.
 *
 * Un seul exemplaire, testé : `shellQuote` protège chaque valeur qui entre dans
 * une commande distante — un chemin, un nom de conteneur, une étiquette. Une
 * copie qui divergerait un jour suffirait à ouvrir une injection ; il en
 * existait onze.
 */

/** Une valeur entre apostrophes, prête pour `sh` : rien n'y est interprété. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** La première ligne non vide d'une sortie, sans ses espaces ; `null` s'il n'y en a pas. */
export function firstLine(text: string): string | null {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0);
  return line?.trim() ?? null;
}
