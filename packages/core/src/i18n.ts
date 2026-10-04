/**
 * The translation mechanism — and nothing but the mechanism.
 *
 * ── Why nothing installed ───────────────────────────────────────────────────
 * `next-intl`, `react-i18next` and `@formatjs` can all do what follows, and
 * much more. None of them pays its way here:
 *
 *   • The first two organize the locale around **routing** — a `/fr/...` or
 *     `/en/...` segment. The panel's URLs have already gone out in invitation
 *     emails, Discord alerts and runbooks; prefixing them would break links
 *     already sent. Disarming them (`localePrefix: 'never'`) amounts to paying
 *     for a dependency in order to neutralize its main feature.
 *   • `react-i18next` and `react-intl` are cut out for the client. This panel
 *     is 80% rendered on the server: we would have to clone an instance per
 *     request, or push a `Provider` into every page.
 *   • All of them ship ICU MessageFormat. We would use two things from it:
 *     substitutions and plurals. Both fit in forty lines, with
 *     `Intl.PluralRules` doing the hard work.
 *
 * What the home-made version adds, and what decides: **key parity is checked
 * by the compiler**. A dictionary is a typed object, the English version is
 * annotated `Translated<typeof fr>` — a forgotten or extra key fails
 * `pnpm typecheck`, not a test one can forget to write, not a `key not found`
 * on screen in front of a user.
 *
 * ── Why in `core` and not in `apps/web` ─────────────────────────────────────
 * The worker composes alerts, and `@pupitre/db` carries catalogs whose labels
 * are displayed. All three must render the same sentence in the same
 * language. The mechanism therefore lives where all three can reach it. The
 * *dictionaries*, on the other hand, stay with their owner: the interface's in
 * `apps/web/src/i18n/messages`, the domain's next to the domain.
 */

/**
 * The languages in which the panel reads **entirely**. A language only gets in
 * here together with its complete dictionary: one more entry without a
 * translation would produce exactly what we want to avoid — a screen half
 * English, half French.
 */
export const UI_LANGUAGES = ['fr', 'en'] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

export const DEFAULT_UI_LANGUAGE: UiLanguage = 'en';

/**
 * The interface language is **derived** from the regional settings' locale; it
 * is not set separately.
 *
 * Two settings for one question — "which language do you speak to me?" — would
 * have contradicted each other the day someone set `en-GB` on one side and
 * "French" on the other. The locale already decides the names of the months
 * and the day/month order: it decides the words too. A single place to change,
 * a single possible state.
 *
 * The fallback is English, deliberately: an instance set to `de-DE` did not ask
 * for French. It gets the project's common language until someone writes `de`.
 */
export function languageOf(locale: string): UiLanguage {
  const primary = locale.toLowerCase().split('-')[0];
  return (UI_LANGUAGES as readonly string[]).includes(primary ?? '')
    ? (primary as UiLanguage)
    : 'en';
}

/**
 * A dictionary entry: either a sentence, or its plural forms.
 *
 * `zero` is optional and is not a grammatical form at all — neither French nor
 * English has one. It is the place for « Aucune cible » where « 0 cible »
 * would read badly. Absent, `Intl.PluralRules` decides alone.
 */
export type PluralForms = { zero?: string; one: string; other: string };
export type MessageEntry = string | PluralForms;
export type Dict = Readonly<Record<string, MessageEntry>>;

/**
 * The translated version of a dictionary, as the compiler sees it: same keys,
 * same forms. It is **the** anti-regression guard — the others only confirm
 * what this one already refused to compile.
 */
export type Translated<F extends Dict> = {
  [K in keyof F]: F[K] extends string ? string : PluralForms;
};

/** A dictionary and its translation, paired. It is what a screen imports. */
export type Bundle<F extends Dict = Dict> = {
  readonly fr: F;
  readonly en: Translated<F>;
};

export type Vars = Readonly<Record<string, string | number>>;

/**
 * Pairs a French dictionary with its English translation.
 *
 * The `Translated<F>` annotation on the `en` parameter does all the work: a
 * missing key is a type error, an extra key too (excess property check on an
 * object literal), and so is a sentence promised in the plural that only
 * returns a string.
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
 * Picks the form, then substitutes.
 *
 * French and English diverge on zero — « 0 cible prête » versus
 * "0 targets ready" — and that is precisely what `Intl.PluralRules` knows: it
 * classes 0 as `one` for French, as `other` for English. The
 * `${n > 1 ? 's' : ''}` scattered through the code did not survive the switch;
 * this function does.
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
 * Renders a key. Never throws and never returns the bare key: showing
 * `settings.notifications.title` to a user is worse than showing them French.
 * We therefore fall back on the source language, which always exists.
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

/** The function a component calls. Bound to a dictionary and a language. */
export type Translate<F extends Dict> = (key: keyof F & string, vars?: Vars) => string;

/** Binds a dictionary to a language. Pure, hence identical on server and client. */
export function translator<F extends Dict>(bundle: Bundle<F>, lang: UiLanguage): Translate<F> {
  return (key, vars) => renderMessage(bundle, lang, key, vars);
}
