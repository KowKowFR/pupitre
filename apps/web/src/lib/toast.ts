/**
 * Toasts — the feedback of a gesture that succeeded (or failed) out of view.
 *
 * A tiny store rather than a library: the kit sets everything — 360 px at the
 * bottom right, three at most, a 5 s timer that pauses on hover, an error that
 * stays until it is closed — and there is nothing more to configure.
 *
 * The text takes **the verb of the button** that triggered it: "Deployment
 * queued", not "Success".
 */

export type ToastTone = 'ok' | 'accent' | 'warn' | 'danger';

export type ToastInput = {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** An optional action: Follow, Undo… */
  action?: { label: string; href?: string; onClick?: () => void };
};

export type ToastItem = ToastInput & {
  id: number;
  tone: ToastTone;
  /** Lifetime in ms; `null` for a toast that stays (error). */
  life: number | null;
  closing: boolean;
};

const TOAST_LIFE_MS = 5000;
const TOAST_MAX = 3;

type Listener = () => void;

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getToasts(): ToastItem[] {
  return items;
}

/**
 * Adds a toast. Beyond three, the oldest goes — except an error, which is never
 * pushed out by a success.
 */
export function toast(input: ToastInput): number {
  const tone = input.tone ?? 'ok';
  const item: ToastItem = {
    ...input,
    id: nextId++,
    tone,
    life: tone === 'danger' ? null : TOAST_LIFE_MS,
    closing: false,
  };
  let next = [...items, item];
  while (next.length > TOAST_MAX) {
    const victim = next.find((candidate) => candidate.tone !== 'danger') ?? next[0];
    next = next.filter((candidate) => candidate !== victim);
  }
  items = next;
  emit();
  return item.id;
}

/** Starts the animated exit; the component removes the element at the end. */
export function dismissToast(id: number): void {
  items = items.map((item) => (item.id === id ? { ...item, closing: true } : item));
  emit();
}

export function removeToast(id: number): void {
  items = items.filter((item) => item.id !== id);
  emit();
}
