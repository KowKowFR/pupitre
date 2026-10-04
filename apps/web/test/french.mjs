/**
 * "Is this string French?"
 *
 * The detector must be *precise* before being exhaustive. A guard that reports a
 * false positive per screen ends up commented out in the config file, and the
 * second language rots three weeks later — which is precisely what we try to
 * prevent.
 *
 * Two signals, neither of which is enough alone:
 *   • an accented character specific to French;
 *   • two distinct French function words, chosen for being homographs neither of
 *     English nor of technical vocabulary ("on", "son", "sur", "par" are
 *     therefore absent from the list: they appear in English or in property
 *     names).
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
 * The strings that contain accents without being interface: language names in
 * their own language, units, data values.
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

/** A template's `{name}` substitutions — they must survive the translation. */
export function placeholdersOf(text) {
  return new Set([...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]));
}
