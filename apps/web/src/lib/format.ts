import type { AppSettings, DateStyleName } from '@pupitre/core';

/**
 * Formatage des dates, à partir des paramètres d'instance.
 *
 * Pas de `'server-only'` ici : `targets-table.tsx` est un composant *client*,
 * `audit-table.tsx` un composant *serveur*, et les deux doivent afficher la
 * même chaîne pour la même date. C'est aussi pourquoi le fuseau est toujours
 * explicite et jamais celui du navigateur — un `Intl.DateTimeFormat` sans
 * `timeZone` rendrait « 14:32 » côté serveur (UTC dans le conteneur) et
 * « 15:32 » côté client (Europe/Paris), et Next signalerait une erreur
 * d'hydratation à la première table de dates.
 *
 * **Descente par props, pas par contexte React.** Un contexte posé dans
 * `(app)/layout.tsx` serait plus court à écrire, mais un contexte n'est
 * lisible que depuis un composant client : `audit-table.tsx`, qui est rendu
 * sur le serveur, ne pourrait pas s'en servir, et il faudrait le convertir en
 * composant client pour la seule raison d'afficher une date. Les props
 * traversent les deux mondes sans rien convertir.
 */

export type FormatSettings = {
  timezone: string;
  locale: string;
  dateStyle: DateStyleName;
  timeStyle: DateStyleName;
};

/** Extrait de quoi formater à partir des paramètres complets. */
export function formatSettingsOf(settings: AppSettings): FormatSettings {
  return {
    timezone: settings.timezone,
    locale: settings.locale,
    dateStyle: settings.dateStyle,
    timeStyle: settings.timeStyle,
  };
}

/**
 * Construire un `Intl.DateTimeFormat` coûte plus cher que de l'utiliser : on
 * garde les instances, indexées par leur configuration. Le nombre de
 * combinaisons est borné par les paramètres, jamais par les données.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(settings: FormatSettings): Intl.DateTimeFormat {
  const key = `${settings.locale}|${settings.timezone}|${settings.dateStyle}|${settings.timeStyle}`;
  const cached = formatters.get(key);
  if (cached) return cached;

  const created = new Intl.DateTimeFormat(settings.locale, {
    dateStyle: settings.dateStyle,
    timeStyle: settings.timeStyle,
    timeZone: settings.timezone,
  });
  formatters.set(key, created);
  return created;
}

export type DateInput = Date | string | number | null | undefined;

/**
 * Formate une date. `null` rend le texte de repli plutôt qu'une exception :
 * « jamais testée », « aucune exécution » sont des cas normaux, pas des erreurs.
 */
export function formatDateTime(
  value: DateInput,
  settings: FormatSettings,
  fallback = '—',
): string {
  if (value === null || value === undefined || value === '') return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return formatterFor(settings).format(date);
}

/** Formateur pré-lié, pour les composants qui affichent beaucoup de dates. */
export function createDateFormatter(
  settings: FormatSettings,
  fallback = '—',
): (value: DateInput) => string {
  return (value) => formatDateTime(value, settings, fallback);
}

/**
 * Étiquette du fuseau à afficher en tête de colonne, à la place du « (UTC) »
 * qui était écrit en dur : « Europe/Paris », « UTC », etc.
 */
export function timeZoneLabel(settings: FormatSettings): string {
  return settings.timezone;
}
