import 'server-only';
import { cache } from 'react';
import {
  DEFAULT_UI_LANGUAGE,
  languageOf,
  translator,
  type Bundle,
  type Dict,
  type Translate,
  type UiLanguage,
} from '@pupitre/core';
import { getAppSettings } from '@pupitre/db';

/**
 * The language, server side.
 *
 * ── Why the instance settings, and not a per-account preference ─────────────
 * The panel is not the only mouth that speaks. The worker composes alerts with
 * nobody in front of it; the invitation email goes to someone who has no account
 * yet, hence no preference; the daily digest is addressed to a list. These three
 * need **one** instance language, so one would be needed anyway.
 *
 * Adding a per-account preference on top would only make the panel bilingual:
 * the English-speaking contractor would read an English screen, then receive the
 * alert of the deployment they just started in French. That is exactly the half
 * translation we try to avoid — with, as a bonus, a column, a migration and one
 * more read per render.
 *
 * The price is real and assumed: on a French-speaking instance, the English
 * speaker reads French. The day this price becomes too high, everything fits in
 * this function: `currentLanguage()` would look at the session's preference
 * first, and fall back on the instance. Nothing else in the panel knows where the
 * language comes from.
 *
 * ── Why a `cache()` ─────────────────────────────────────────────────────────
 * Each server component that shows text calls this. `getAppSettings()` already
 * has its 5 s cache, but it is process-wide: `cache()` also avoids the repeated
 * promise within one render. The 5 s also explain why changing the language
 * requires neither a redeployment nor a reconnection — the next render reads
 * again, at worst five seconds later.
 */
export const currentLanguage = cache(async (): Promise<UiLanguage> => {
  try {
    const { settings } = await getAppSettings();
    return languageOf(settings.locale);
  } catch {
    // Crossing `next build` without a database: a page title is never a reason to
    // fail a build. The same trade-off as in the layout.
    return DEFAULT_UI_LANGUAGE;
  }
});

/**
 * A server component's `t`. We pass the dictionary, not its name: that is what
 * allows the compiler to know that screen's keys, and the bundler to only load
 * that screen's dictionary.
 */
export async function getT<F extends Dict>(bundle: Bundle<F>): Promise<Translate<F>> {
  return translator(bundle, await currentLanguage());
}
