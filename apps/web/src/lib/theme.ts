/**
 * Le thème de l'interface : Système, Clair ou Sombre.
 *
 * Le choix vit dans un cookie et non dans `localStorage` parce que c'est le
 * serveur qui peint la première image : il lit le cookie, pose `.dark` ou
 * `.light` sur <html>, et la page arrive déjà dans le bon thème — sans script
 * bloquant, sans flash. « Système » ne pose aucune classe : le média décide,
 * et un changement de réglage du poste s'applique sans recharger.
 *
 * C'est une préférence de poste, pas de compte : elle ne touche pas la base.
 * Ce module reste pur — ni `next/headers` ni `document` — pour être importé
 * des deux côtés.
 */

export const THEME_COOKIE = 'pp-theme';

export const THEME_CHOICES = ['system', 'light', 'dark'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

export function parseTheme(value: string | undefined | null): ThemeChoice {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/** La classe à poser sur <html>, ou rien quand le système décide. */
export function themeClass(choice: ThemeChoice): string | undefined {
  return choice === 'system' ? undefined : choice;
}

/**
 * Applique un choix dans le navigateur : cookie d'un an, puis classe sur
 * <html>. Le rendu suivant du serveur relira le même cookie.
 */
export function applyTheme(choice: ThemeChoice): void {
  const maxAge = choice === 'system' ? 0 : 60 * 60 * 24 * 365;
  document.cookie = `${THEME_COOKIE}=${choice}; path=/; max-age=${maxAge}; samesite=lax`;
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  const cls = themeClass(choice);
  if (cls) root.classList.add(cls);
}
