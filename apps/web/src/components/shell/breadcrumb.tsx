'use client';

import * as React from 'react';

/**
 * The breadcrumb's last link — the page's object ("prod-1", "New application").
 * The top bar knows the instance and the section through the path; only the
 * screen knows the name of what it shows. It declares it by rendering
 * `<Crumb label="…" />`, which fades away when the screen goes.
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

/** Declares the page's object. Renders nothing. */
export function Crumb({ label }: { label: string }) {
  const { set } = React.useContext(CrumbContext);
  React.useEffect(() => {
    set(label);
    return () => set(null);
  }, [label, set]);
  return null;
}
