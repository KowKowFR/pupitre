/**
 * Toasts — le retour d'un geste qui a abouti (ou échoué) hors de la vue.
 *
 * Un store minuscule plutôt qu'une bibliothèque : le kit fixe tout — 360 px en
 * bas à droite, trois au plus, une minuterie de 5 s qui se met en pause au
 * survol, une erreur qui reste jusqu'à ce qu'on la ferme — et il n'y a rien à
 * configurer de plus.
 *
 * Le texte reprend **le verbe du bouton** qui l'a déclenché : « Déploiement
 * enfilé », pas « Succès ».
 */

export type ToastTone = 'ok' | 'accent' | 'warn' | 'danger';

export type ToastInput = {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Une action facultative : Suivre, Annuler… */
  action?: { label: string; href?: string; onClick?: () => void };
};

export type ToastItem = ToastInput & {
  id: number;
  tone: ToastTone;
  /** Durée de vie en ms ; `null` pour un toast qui reste (erreur). */
  life: number | null;
  closing: boolean;
};

export const TOAST_LIFE_MS = 5000;
export const TOAST_MAX = 3;

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
 * Ajoute un toast. Au-delà de trois, le plus ancien part — sauf une erreur,
 * qui ne se fait jamais pousser dehors par un succès.
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

/** Commence la sortie animée ; le composant retire l'élément à la fin. */
export function dismissToast(id: number): void {
  items = items.map((item) => (item.id === id ? { ...item, closing: true } : item));
  emit();
}

export function removeToast(id: number): void {
  items = items.filter((item) => item.id !== id);
  emit();
}
