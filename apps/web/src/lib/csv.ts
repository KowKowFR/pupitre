/**
 * CSV des exports, séparé de `export.ts` parce qu'il est pur : il se teste
 * sans serveur, et `export.ts` ne se charge que côté serveur.
 */

/**
 * Une cellule CSV (RFC 4180), neutralisée contre l'injection de formules.
 *
 * Le fichier finira dans un tableur. Une valeur qui commence par `=`, `+`,
 * `-`, `@`, une tabulation ou un retour chariot y serait exécutée comme une
 * formule — et un message d'erreur de déploiement vient d'une machine
 * distante, donc de n'importe qui. On la préfixe d'une apostrophe, que le
 * tableur n'affiche pas.
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Une ligne CSV, fin de ligne CRLF comme le veut la RFC 4180. */
export function csvRow(cells: ReadonlyArray<string | number | boolean | null | undefined>): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}
