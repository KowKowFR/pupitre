import type { AppSettings, DateStyleName } from '@pupitre/core';

/**
 * Formatage des dates **et des nombres**, à partir des paramètres d'instance.
 *
 * Pas de `'server-only'` ici : `targets-view.tsx` est un composant *client*,
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
 *
 * **Les nombres suivent exactement la même règle, et pour la même raison.**
 * `1 234,5` en français, `1,234.5` en anglais : c'est la locale d'instance qui
 * tranche, jamais `navigator.language`, jamais `undefined`. Un
 * `toLocaleString()` sans locale prend celle du navigateur côté client et
 * celle du conteneur côté serveur — deux chaînes différentes pour le même
 * nombre, et Next signale une erreur d'hydratation. La locale voyage donc dans
 * `FormatSettings`, à côté du fuseau, et les deux mondes lisent la même valeur.
 *
 * `settings.locale` est utilisé **tel quel** (`fr-FR`, `en-GB`) et jamais
 * réduit à ses deux premières lettres : `en-GB` et `en-US` n'écrivent pas la
 * même date, et rien ne garantit qu'`Intl` rende pour `fr` ce qu'il rend pour
 * `fr-FR`.
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
 * Formate une date avec des composantes choisies par l'appelant.
 *
 * Toutes les dates du panel ne se lisent pas avec `dateStyle`/`timeStyle` : un
 * axe de graphique n'écrit que l'heure et la minute, une frise que le jour et
 * l'heure. Ces figures gardent donc leurs options — c'est leur mise en page
 * qui les impose —, mais elles n'ont aucune raison de garder leur locale.
 *
 * Le `timeZone` n'est **pas** imposé ici : certains appelants l'épinglent
 * (l'horodatage d'un déploiement est lu en UTC, délibérément), d'autres
 * suivent l'instance. Chacun le dit dans ses options.
 */
export function formatDateTimeWith(
  value: DateInput,
  settings: FormatSettings,
  options: Intl.DateTimeFormatOptions,
  fallback = '—',
): string {
  if (value === null || value === undefined || value === '') return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return partsFormatterFor(settings.locale, options).format(date);
}

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatterFor(
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  const cached = partFormatters.get(key);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat(locale, options);
  partFormatters.set(key, created);
  return created;
}

/**
 * Les nombres, dans la locale de l'instance.
 *
 * Même cache et même raison que pour les dates : construire un
 * `Intl.NumberFormat` coûte plus cher que de s'en servir, et le nombre de
 * combinaisons est borné par les appelants.
 */
const numberFormatters = new Map<string, Intl.NumberFormat>();

function numberFormatterFor(
  locale: string,
  options: Intl.NumberFormatOptions | undefined,
): Intl.NumberFormat {
  const key = `${locale}|${options ? JSON.stringify(options) : ''}`;
  const cached = numberFormatters.get(key);
  if (cached) return cached;
  const created = new Intl.NumberFormat(locale, options);
  numberFormatters.set(key, created);
  return created;
}

/**
 * Formate un nombre. Sans options, c'est exactement ce que rendait
 * `value.toLocaleString(locale)` — séparateur de milliers compris.
 */
export function formatNumber(
  value: number,
  settings: FormatSettings,
  options?: Intl.NumberFormatOptions,
): string {
  return numberFormatterFor(settings.locale, options).format(value);
}
