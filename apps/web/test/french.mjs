/**
 * « Cette chaîne est-elle du français ? »
 *
 * Le détecteur doit être *précis* avant d'être exhaustif. Une garde qui signale
 * un faux positif par écran finit commentée dans le fichier de config, et la
 * seconde langue pourrit trois semaines plus tard — ce qu'on cherche
 * précisément à empêcher.
 *
 * Deux signaux, aucun des deux suffisant seul :
 *   • un caractère accenté propre au français ;
 *   • deux mots-outils français distincts, choisis pour n'être homographes ni
 *     de l'anglais ni du vocabulaire technique (« on », « son », « sur », « par »
 *     sont donc absents de la liste : ils apparaissent en anglais ou dans des
 *     noms de propriétés).
 */

const ACCENTED = /[éèêëàâäçùûüôöîïœÉÈÊËÀÂÄÇÙÛÜÔÖÎÏŒ]/;

const STOPWORDS = new Set([
  'le',
  'la',
  'les',
  'une',
  'des',
  'du',
  'aux',
  'est',
  'sont',
  'pas',
  'pour',
  'avec',
  'sans',
  'dans',
  'que',
  'qui',
  'cette',
  'ces',
  'leur',
  'leurs',
  'aucun',
  'aucune',
  'chaque',
  'toujours',
  'jamais',
  'tout',
  'tous',
  'toute',
  'toutes',
  'cet',
  'vers',
  'entre',
  'depuis',
  'alors',
  'donc',
  'mais',
  'puis',
  'ainsi',
  'ici',
  'quand',
  'faut',
  'peut',
  'doit',
  'elle',
  'ils',
  'nous',
  'vous',
  'votre',
  'vos',
  'notre',
  'plus',
  'moins',
  'encore',
  'seulement',
]);

/**
 * Les chaînes qui contiennent des accents sans être de l'interface : noms de
 * langues dans leur propre langue, unités, valeurs de données.
 */
const EXEMPT = new Set(['Français (France)', 'Español (España)', 'français', 'fr', 'fr-FR']);

export function isFrench(text) {
  const value = String(text).trim();
  if (value.length < 3) return false;
  if (EXEMPT.has(value)) return false;

  if (ACCENTED.test(value)) return true;

  const words = value.toLowerCase().match(/[a-zà-ÿ']+/g);
  if (!words) return false;
  const found = new Set(words.filter((word) => STOPWORDS.has(word)));
  return found.size >= 2;
}

/** Les substitutions `{nom}` d'un gabarit — elles doivent survivre à la traduction. */
export function placeholdersOf(text) {
  return new Set([...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]));
}
