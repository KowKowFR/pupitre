/**
 * L'élément ouvert dans un drawer vit dans l'URL — `?target=prod-1`,
 * `?run=…` — pour qu'un aperçu se partage, se recharge, et que le bouton
 * Précédent le referme.
 *
 * Ces fonctions sont pures : le hook `useDrawerSelection` les branche sur
 * l'historique du navigateur, les tests les appellent directement.
 */

/** L'identifiant sélectionné sous `key`, ou `null`. Une valeur vide compte pour rien. */
export function selectionFrom(search: string | URLSearchParams, key: string): string | null {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const value = params.get(key);
  return value === null || value === '' ? null : value;
}

/**
 * L'URL de la même page avec `key` posé (ou retiré si `id` est `null`). Les
 * autres paramètres — filtres, page, fenêtre — sont conservés tels quels.
 */
export function hrefWithSelection(
  pathname: string,
  search: string | URLSearchParams,
  key: string,
  id: string | null,
): string {
  const params = new URLSearchParams(typeof search === 'string' ? search : search.toString());
  if (id === null) params.delete(key);
  else params.set(key, id);
  const query = params.toString();
  return query === '' ? pathname : `${pathname}?${query}`;
}

/**
 * La ligne voisine dans l'ordre affiché : `1` pour la suivante (J), `-1` pour
 * la précédente (K). `null` aux bords — on ne boucle pas, un opérateur qui
 * descend une liste doit sentir qu'il en a atteint le bout.
 */
export function neighbour<T>(ids: readonly T[], current: T | null, direction: 1 | -1): T | null {
  if (current === null)
    return ids.length > 0 ? (direction === 1 ? ids[0]! : ids[ids.length - 1]!) : null;
  const index = ids.indexOf(current);
  if (index === -1) return null;
  const next = index + direction;
  return next >= 0 && next < ids.length ? ids[next]! : null;
}

/**
 * Une frappe au clavier vient-elle d'une zone de saisie ? Les raccourcis à
 * une lettre (J, K, G, ?) doivent alors se taire.
 */
export function isTyping(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object' || !('tagName' in target)) return false;
  const element = target as {
    tagName: string;
    isContentEditable?: boolean;
    getAttribute?: (name: string) => string | null;
  };
  const tag = element.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    const type = (element.getAttribute?.('type') ?? 'text').toLowerCase();
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range'].includes(type);
  }
  return Boolean(element.isContentEditable);
}

export type DrawerKey = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  /** Balise de l'élément qui a reçu la frappe, en minuscules. */
  tag?: string;
  typing?: boolean;
};

/**
 * Ce que fait une touche dans un drawer ouvert : J la ligne suivante, K la
 * précédente, Entrée ouvre la fiche — sauf sur un lien ou un bouton, qui ont
 * déjà leur propre sens pour Entrée. Échap est traité par la couche elle-même.
 */
export function drawerKeyAction(
  event: DrawerKey,
  nav: { canPrevious: boolean; canNext: boolean; hasRecord: boolean },
): 'next' | 'previous' | 'record' | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.typing) return null;
  const key = event.key.toLowerCase();
  if (key === 'j' && nav.canNext) return 'next';
  if (key === 'k' && nav.canPrevious) return 'previous';
  if (event.key === 'Enter' && nav.hasRecord && event.tag !== 'a' && event.tag !== 'button')
    return 'record';
  return null;
}
