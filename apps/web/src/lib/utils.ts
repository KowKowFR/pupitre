import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * `tailwind-merge` doit connaître l'échelle du design system : sans cela,
 * `text-cap` ou `text-page` — des tailles — passeraient pour des couleurs, et
 * `cn('text-cap text-text-3')` jetterait silencieusement la taille.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['cap', 'h', 'title', 'drawer', 'page', 'stat'],
      shadow: ['focus', 'focus-danger'],
      ease: ['std'],
      animate: [
        'drawer-in',
        'drawer-out',
        'dialog-in',
        'dialog-out',
        'cmdk-in',
        'pop',
        'toast-in',
        'rise',
        'sweep',
        'soft-pulse',
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
