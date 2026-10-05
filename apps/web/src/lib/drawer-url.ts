/**
 * The item open in a drawer lives in the URL — `?target=prod-1`, `?run=…` — so
 * that an overview can be shared, reloaded, and closed by the Back button.
 *
 * These functions are pure: the `useDrawerSelection` hook plugs them into the
 * browser's history, the tests call them directly.
 */

/** The identifier selected under `key`, or `null`. An empty value counts as nothing. */
export function selectionFrom(search: string | URLSearchParams, key: string): string | null {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const value = params.get(key);
  return value === null || value === '' ? null : value;
}

/**
 * The URL of the same page with `key` set (or removed if `id` is `null`). The
 * other parameters — filters, page, window — are kept as is.
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
 * The neighboring row in the displayed order: `1` for the next one (J), `-1` for
 * the previous one (K). `null` at the edges — we do not loop, an operator going
 * down a list must feel they reached its end.
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
 * Does a keystroke come from an input area? The single-letter shortcuts (J, K, G,
 * ?) must then go quiet.
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
  /** The tag of the element that received the keystroke, in lowercase. */
  tag?: string;
  typing?: boolean;
};

/**
 * What a key does in an open drawer: J the next row, K the previous one, Enter
 * opens the record — except on a link or a button, which already have their own
 * meaning for Enter. Escape is handled by the layer itself.
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
