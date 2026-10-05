'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import {
  DEFAULT_UI_LANGUAGE,
  translator,
  type Bundle,
  type Dict,
  type Translate,
  type UiLanguage,
} from '@pupitre/core';

/**
 * The language, client side.
 *
 * The context only carries **the language**, never the dictionaries. It is the
 * point that decides the pages' size: if the provider carried the messages, all
 * the panel's texts — about a hundred kilobytes — would cross the RSC payload at
 * each navigation. By only carrying two letters, the dictionaries stay
 * *modules*, imported by the screens that use them, split by the bundler like
 * the rest of the code and cached by the browser once and for all.
 *
 * That is also why `useT()` takes the dictionary as an argument rather than a
 * namespace name: a name would require a central registry, hence a module that
 * imports all the dictionaries, hence the end of the splitting.
 */
const LanguageContext = createContext<UiLanguage>(DEFAULT_UI_LANGUAGE);

export function LanguageProvider({
  language,
  children,
}: {
  language: UiLanguage;
  children: ReactNode;
}) {
  return <LanguageContext.Provider value={language}>{children}</LanguageContext.Provider>;
}

/** The current language, for what needs it without needing `t`. */
export function useLanguage(): UiLanguage {
  return useContext(LanguageContext);
}

/** A client component's `t`. The same pure function as on the server side. */
export function useT<F extends Dict>(bundle: Bundle<F>): Translate<F> {
  const language = useContext(LanguageContext);
  return useMemo(() => translator(bundle, language), [bundle, language]);
}
