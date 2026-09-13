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
 * La langue, côté client.
 *
 * Le contexte ne porte que **la langue**, jamais les dictionnaires. C'est le
 * point qui décide de la taille des pages : si le fournisseur transportait les
 * messages, l'intégralité des textes du panel — une centaine de kilo-octets —
 * traverserait la charge utile RSC à chaque navigation. En ne transportant que
 * deux lettres, les dictionnaires restent des *modules*, importés par les
 * écrans qui s'en servent, découpés par le bundler comme le reste du code et
 * mis en cache par le navigateur une fois pour toutes.
 *
 * C'est aussi pourquoi `useT()` prend le dictionnaire en argument plutôt qu'un
 * nom d'espace : un nom demanderait un registre central, donc un module qui
 * importe tous les dictionnaires, donc la fin du découpage.
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

/** La langue courante, pour ce qui a besoin d'elle sans avoir besoin de `t`. */
export function useLanguage(): UiLanguage {
  return useContext(LanguageContext);
}

/** Le `t` d'un composant client. Même fonction pure que côté serveur. */
export function useT<F extends Dict>(bundle: Bundle<F>): Translate<F> {
  const language = useContext(LanguageContext);
  return useMemo(() => translator(bundle, language), [bundle, language]);
}
