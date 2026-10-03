/**
 * La correspondance tolérante de la palette ⌘K : ce qu'on tape, contre ce
 * qu'un objet porte (nom, slug, hôte, étiquettes…).
 *
 * Tolérante, mais pas floue au point de tout rendre :
 *
 * - les accents et la casse ne comptent pas (« deploiement » trouve
 *   « Déploiement ») ;
 * - **chaque mot tapé doit répondre** quelque part : « api prod » ne rend pas
 *   tout ce qui contient « prod » ;
 * - un mot répond, du plus fort au plus faible : le champ entier, un début de
 *   mot, un morceau de mot, puis — à partir de trois lettres — les lettres
 *   dans l'ordre (« prd1 » → « prod-1 »), ou une faute de frappe
 *   (« umamo » → « umami », une lettre fausse, en trop, manquante ou
 *   inversée ; deux à partir de huit lettres).
 *
 * Le score sert à ranger : un objet qui répond par son nom passe devant un
 * objet qui répond par une faute de frappe.
 */

/** Sans accents, en minuscules. */
export function foldText(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Les mots d'une saisie, repliés. Le `#` d'un numéro de run tombe. */
export function queryTokens(query: string): string[] {
  return foldText(query)
    .split(/\s+/)
    .map((token) => token.replace(/^#/, ''))
    .filter((token) => token !== '');
}

function wordsOf(field: string): string[] {
  return field.split(/[^a-z0-9]+/).filter((word) => word !== '');
}

/** Les lettres de `token` apparaissent-elles dans l'ordre dans `text` ? */
function isSubsequence(token: string, text: string): boolean {
  let index = 0;
  for (const char of text) {
    if (char === token[index]) index += 1;
    if (index === token.length) return true;
  }
  return false;
}

/**
 * Distance de Damerau-Levenshtein (alignement optimal), bornée : au-delà de
 * `max`, on s'arrête et on rend `max + 1`.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i < rows; i += 1) {
    let rowMin = Number.POSITIVE_INFINITY;
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length]![b.length]!;
}

/**
 * Ce que vaut un mot tapé contre un champ : 0 s'il n'y répond pas. Un champ
 * de prose (une description) ne répond qu'à un vrai morceau de texte : les
 * lettres dans l'ordre et les fautes de frappe trouveraient n'importe quoi
 * dans une phrase.
 */
function tokenScore(token: string, field: string, prose: boolean): number {
  if (field === token) return 5;
  const words = wordsOf(field);
  if (field.startsWith(token) || words.some((word) => word.startsWith(token))) return 4;
  if (field.includes(token)) return 3;
  if (prose) return 0;
  // Les mots, le champ entier, et le champ sans séparateurs : « prd1 » se lit
  // dans « prod-1 », « portail-cleint » contre « portail-client ».
  const compact = field.replace(/[^a-z0-9]/g, '');
  const candidates = [...words, field, compact];
  // Les lettres dans l'ordre, mais en commençant comme le mot, et dans un mot
  // guère plus long que la saisie : « prd1 » pour « prod-1 », pas « umamo »
  // éparpillé dans « open-webui-documentation ».
  if (
    token.length >= 3 &&
    candidates.some(
      (word) =>
        word[0] === token[0] && word.length <= token.length * 2 && isSubsequence(token, word),
    )
  ) {
    return 2;
  }
  if (token.length >= 4) {
    const allowed = token.length >= 8 ? 2 : 1;
    // Contre le mot entier, ou contre son début de même longueur : « umam »
    // tapé pour « umami » ne doit pas être puni pour la lettre qui manque.
    if (
      candidates.some(
        (word) =>
          editDistance(token, word, allowed) <= allowed ||
          editDistance(token, word.slice(0, token.length), allowed) <= allowed,
      )
    ) {
      return 1;
    }
  }
  return 0;
}

/**
 * Le score d'un objet pour une saisie : la somme, mot par mot, de la meilleure
 * réponse parmi ses champs. 0 dès qu'un mot ne répond nulle part. Une saisie
 * vide vaut 1 : tout répond, sans ordre.
 */
export function matchScore(
  query: string,
  fields: ReadonlyArray<string | null | undefined>,
  /** Des champs de prose : texte exact seulement, sans tolérance aux fautes. */
  prose: ReadonlyArray<string | null | undefined> = [],
): number {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return 1;
  const fold = (list: ReadonlyArray<string | null | undefined>) =>
    list.filter((field): field is string => Boolean(field)).map(foldText);
  const names = fold(fields);
  const texts = fold(prose);
  let total = 0;
  for (const token of tokens) {
    let best = 0;
    for (const field of names) best = Math.max(best, tokenScore(token, field, false));
    for (const field of texts) best = Math.max(best, tokenScore(token, field, true));
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

/** Les objets qui répondent, du meilleur au moins bon ; l'ordre d'origine départage. */
export function rankByMatch<T>(
  query: string,
  items: readonly T[],
  fields: (item: T) => ReadonlyArray<string | null | undefined>,
  prose: (item: T) => ReadonlyArray<string | null | undefined> = () => [],
): T[] {
  return items
    .map((item, index) => ({ item, index, score: matchScore(query, fields(item), prose(item)) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}
