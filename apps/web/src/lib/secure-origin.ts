/**
 * What the browser only gives a secure origin, done for every origin.
 *
 * `crypto.randomUUID` and `navigator.clipboard` only exist on HTTPS or
 * `localhost`. A self-hosted panel is often browsed over HTTP on the local
 * network — `http://192.168.1.20:3000` —, where both are `undefined`: a screen
 * that calls them breaks, or a "Copy" button does nothing. The screens call
 * these two instead; a test refuses the originals anywhere else.
 */

/** A version 4 UUID, from `getRandomValues` — which exists on every origin. */
export function randomUuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Copies text to the clipboard. On a secure origin, the Clipboard API;
 * elsewhere, a selection in a hidden field and the copy command, which the
 * browser still allows during a click. `false`: nothing was copied — the
 * caller leaves the value on screen, selectable by hand.
 *
 * The hidden field goes inside the dialog that holds the focus, when there is
 * one: a drawer keeps the focus within itself, and a field outside it would
 * lose the selection — the command would then copy whatever was selected.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Refused (permission, focus): the fallback may still succeed.
    }
  }
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.top = '-1000px';
  field.style.opacity = '0';
  const focused = document.activeElement as HTMLElement | null;
  const host =
    (focused?.closest?.('[role="dialog"], dialog') as HTMLElement | null) ?? document.body;
  host.appendChild(field);
  field.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
    focused?.focus();
  }
}
