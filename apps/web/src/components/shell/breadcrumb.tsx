'use client';

import * as React from 'react';

/**
 * Le dernier maillon du fil d'Ariane — l'objet de la page (« prod-1 »,
 * « Nouvelle application »). La barre haute connaît l'instance et la section
 * par le chemin ; seul l'écran connaît le nom de ce qu'il montre. Il le
 * déclare en rendant `<Crumb label="…" />`, qui s'efface quand l'écran s'en va.
 */

type CrumbValue = {
  label: string | null;
  set: (label: string | null) => void;
};

const CrumbContext = React.createContext<CrumbValue>({ label: null, set: () => undefined });

export function CrumbProvider({ children }: { children: React.ReactNode }) {
  const [label, setLabel] = React.useState<string | null>(null);
  const value = React.useMemo(() => ({ label, set: setLabel }), [label]);
  return <CrumbContext.Provider value={value}>{children}</CrumbContext.Provider>;
}

export function useCrumb(): string | null {
  return React.useContext(CrumbContext).label;
}

/** Déclare l'objet de la page. Ne rend rien. */
export function Crumb({ label }: { label: string }) {
  const { set } = React.useContext(CrumbContext);
  React.useEffect(() => {
    set(label);
    return () => set(null);
  }, [label, set]);
  return null;
}
