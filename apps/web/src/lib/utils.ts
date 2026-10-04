import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * `tailwind-merge` must know the design system's scale: without that,
 * `text-cap` or `text-page` — sizes — would pass for colors, and
 * `cn('text-cap text-text-3')` would silently throw the size away.
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
