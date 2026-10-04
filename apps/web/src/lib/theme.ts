/**
 * The interface's theme: System, Light or Dark.
 *
 * The choice lives in a cookie and not in `localStorage` because it is the server
 * that paints the first frame: it reads the cookie, sets `.dark` or `.light` on
 * <html>, and the page arrives already in the right theme — without a blocking
 * script, without a flash. "System" sets no class: the media query decides, and a
 * change of the workstation's setting applies without reloading.
 *
 * It is a workstation preference, not an account one: it does not touch the
 * database. This module stays pure — neither `next/headers` nor `document` — to be
 * imported on both sides.
 */

export const THEME_COOKIE = 'pp-theme';

export const THEME_CHOICES = ['system', 'light', 'dark'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

export function parseTheme(value: string | undefined | null): ThemeChoice {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/** The class to set on <html>, or nothing when the system decides. */
export function themeClass(choice: ThemeChoice): string | undefined {
  return choice === 'system' ? undefined : choice;
}

/**
 * Applies a choice in the browser: a one-year cookie, then a class on <html>. The
 * server's next render will read the same cookie again.
 */
export function applyTheme(choice: ThemeChoice): void {
  const maxAge = choice === 'system' ? 0 : 60 * 60 * 24 * 365;
  document.cookie = `${THEME_COOKIE}=${choice}; path=/; max-age=${maxAge}; samesite=lax`;
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  const cls = themeClass(choice);
  if (cls) root.classList.add(cls);
}
