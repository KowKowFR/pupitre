/**
 * Le mécanisme de traduction — et rien que le mécanisme.
 *
 * ── Pourquoi rien d'installé ────────────────────────────────────────────────
 * `next-intl`, `react-i18next` et `@formatjs` savent tous faire ce qui suit,
 * et bien davantage. Aucun ne se paie ici :
 *
 *   • Les deux premiers organisent la locale autour du **routage** — un
 *     segment `/fr/...` ou `/en/...`. Les URL du panel sont déjà parties dans
 *     des e-mails d'invitation, des alertes Discord et des runbooks ; les
 *     préfixer casserait des liens envoyés. Les désarmer (`localePrefix:
 *     'never'`) revient à payer une dépendance pour en neutraliser la
 *     fonctionnalité principale.
 *   • `react-i18next` et `react-intl` sont taillés pour le client. Ce panel est
 *     rendu à 80 % sur le serveur : il faudrait cloner une instance par
 *     requête, ou pousser un `Provider` dans chaque page.
 *   • Tous embarquent ICU MessageFormat. On en utiliserait deux choses : les
 *     substitutions et les pluriels. Les deux tiennent en quarante lignes,
 *     `Intl.PluralRules` faisant le travail difficile.
 *
 * Ce que la maison apporte en plus, et qui décide : **la parité des clés est
 * vérifiée par le compilateur**. Un dictionnaire est un objet typé, la version
 * anglaise est annotée `Translated<typeof fr>` — une clé oubliée ou en trop
 * fait échouer `pnpm typecheck`, pas un test qu'on peut oublier d'écrire, pas
 * un `key not found` à l'écran devant un utilisateur.
 *
 * ── Pourquoi dans `core` et pas dans `apps/web` ─────────────────────────────
 * Le worker compose des alertes, et `@pupitre/db` porte des catalogues dont les
 * libellés s'affichent. Les trois doivent rendre la même phrase dans la même
 * langue. Le mécanisme vit donc là où les trois peuvent l'atteindre. Les
 * *dictionnaires*, eux, restent chez leur propriétaire : ceux de l'interface
 * dans `apps/web/src/i18n/messages`, ceux du domaine à côté du domaine.
 */

/**
 * Les langues dans lesquelles le panel se lit **entièrement**. Une langue
 * n'entre ici qu'accompagnée de son dictionnaire complet : une entrée de plus
 * sans traduction produirait exactement ce qu'on veut éviter — un écran mi-
 * anglais mi-français.
 */
export const UI_LANGUAGES = ['fr', 'en'] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

export const DEFAULT_UI_LANGUAGE: UiLanguage = 'fr';

/**
 * La langue de l'interface se **déduit** de la locale de régionalisation, elle
 * ne se règle pas à part.
 *
 * Deux réglages pour une question — « en quelle langue me parles-tu ? » — se
 * seraient contredits le jour où quelqu'un aurait posé `en-GB` d'un côté et
 * « français » de l'autre. La locale décide déjà du nom des mois et de l'ordre
 * jour/mois : elle décide aussi des mots. Un seul endroit à changer, un seul
 * état possible.
 *
 * Le repli est l'anglais, et c'est délibéré : une instance réglée sur `de-DE`
 * n'a pas demandé du français. Elle obtient la langue véhiculaire du projet en
 * attendant que quelqu'un écrive `de`.
 */
export function languageOf(locale: string): UiLanguage {
  const primary = locale.toLowerCase().split('-')[0];
  return (UI_LANGUAGES as readonly string[]).includes(primary ?? '')
    ? (primary as UiLanguage)
    : 'en';
}

/**
 * Une entrée de dictionnaire : soit une phrase, soit ses formes de pluriel.
 *
 * `zero` est facultatif et n'a rien d'une forme grammaticale — ni le français
 * ni l'anglais n'en ont une. C'est la place de « Aucune cible » là où
 * « 0 cible » se lirait mal. Absent, `Intl.PluralRules` tranche seul.
 */
export type PluralForms = { zero?: string; one: string; other: string };
export type MessageEntry = string | PluralForms;
export type Dict = Readonly<Record<string, MessageEntry>>;

/**
 * La version traduite d'un dictionnaire, vue par le compilateur : mêmes clés,
 * mêmes formes. C'est **la** garde anti-régression — les autres ne font que
 * confirmer ce que celle-ci a déjà refusé de compiler.
 */
export type Translated<F extends Dict> = {
  [K in keyof F]: F[K] extends string ? string : PluralForms;
};

/** Un dictionnaire et sa traduction, appariés. C'est ce qu'un écran importe. */
export type Bundle<F extends Dict = Dict> = {
  readonly fr: F;
  readonly en: Translated<F>;
};

export type Vars = Readonly<Record<string, string | number>>;

/**
 * Apparie un dictionnaire français et sa traduction anglaise.
 *
 * L'annotation `Translated<F>` sur le paramètre `en` fait tout le travail :
 * une clé manquante est une erreur de type, une clé en trop aussi (contrôle
 * des propriétés excédentaires sur un littéral d'objet), et une phrase promise
 * au pluriel qui ne rend qu'une chaîne également.
 */
export function defineMessages<const F extends Dict>(bundle: {
  fr: F;
  en: Translated<F>;
}): Bundle<F> {
  return bundle;
}

const pluralRules = new Map<string, Intl.PluralRules>();

function rulesFor(lang: UiLanguage): Intl.PluralRules {
  const cached = pluralRules.get(lang);
  if (cached) return cached;
  const created = new Intl.PluralRules(lang);
  pluralRules.set(lang, created);
  return created;
}

/**
 * Choisit la forme, puis substitue.
 *
 * Le français et l'anglais divergent sur zéro — « 0 cible prête » contre
 * « 0 targets ready » — et c'est précisément ce que `Intl.PluralRules` sait :
 * il classe 0 en `one` pour le français, en `other` pour l'anglais. Les
 * `${n > 1 ? 's' : ''}` semés dans le code ne survivaient pas au passage ;
 * cette fonction, si.
 */
function selectForm(entry: MessageEntry, lang: UiLanguage, vars: Vars | undefined): string {
  if (typeof entry === 'string') return entry;
  const count = typeof vars?.count === 'number' ? vars.count : 0;
  if (count === 0 && entry.zero !== undefined) return entry.zero;
  return rulesFor(lang).select(count) === 'one' ? entry.one : entry.other;
}

const PLACEHOLDER = /\{(\w+)\}/g;

function interpolate(template: string, vars: Vars | undefined): string {
  if (!vars) return template;
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = vars[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * Rend une clé. Ne lève jamais et ne rend jamais la clé nue : afficher
 * `settings.notifications.title` à un utilisateur est pire que de lui montrer
 * du français. On retombe donc sur la langue source, qui existe toujours.
 */
export function renderMessage<F extends Dict>(
  bundle: Bundle<F>,
  lang: UiLanguage,
  key: keyof F & string,
  vars?: Vars,
): string {
  const entry = (bundle[lang] as Dict)[key] ?? bundle.fr[key];
  if (entry === undefined) return key;
  return interpolate(selectForm(entry, lang, vars), vars);
}

/** La fonction qu'un composant appelle. Liée à un dictionnaire et à une langue. */
export type Translate<F extends Dict> = (key: keyof F & string, vars?: Vars) => string;

/** Lie un dictionnaire à une langue. Pur, donc identique serveur et client. */
export function translator<F extends Dict>(bundle: Bundle<F>, lang: UiLanguage): Translate<F> {
  return (key, vars) => renderMessage(bundle, lang, key, vars);
}
