'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { CommandKey, SectionKey } from '@/lib/navigation';
import { isTyping } from '@/lib/drawer-url';
import { CommandPalette } from './command-palette';
import { ShortcutsDialog } from './shortcuts-dialog';

/**
 * La coquille côté client : l'état de la palette ⌘K et de l'aide des
 * raccourcis, et l'écoute des raccourcis globaux.
 *
 * - ⌘K / Ctrl K : ouvrir ou fermer la palette, depuis n'importe où ;
 * - `G` puis une lettre : aller à une section (D, C, A, P, S) ;
 * - `?` : afficher la liste des raccourcis.
 *
 * Les raccourcis à une lettre se taisent pendant une saisie et quand une
 * couche (dialogue, drawer) est ouverte : ils ne doivent jamais voler une
 * frappe à l'opérateur.
 */

export type PaletteScope = 'deploy' | null;

type ShellValue = {
  openPalette: (scope?: PaletteScope) => void;
  openShortcuts: () => void;
};

const ShellContext = React.createContext<ShellValue>({
  openPalette: () => undefined,
  openShortcuts: () => undefined,
});

export function useShell(): ShellValue {
  return React.useContext(ShellContext);
}

export type ShellSection = { key: SectionKey; href: string; shortcut?: string };

export function ShellProvider({
  sections,
  commands,
  children,
}: {
  sections: ShellSection[];
  commands: CommandKey[];
  children: React.ReactNode;
}) {
  const router = useRouter();
  // `session` change à chaque ouverture : la palette est remontée, et repart
  // d'une saisie vide sans effet de remise à zéro.
  const [palette, setPalette] = React.useState<{ open: boolean; scope: PaletteScope; session: number }>({
    open: false,
    scope: null,
    session: 0,
  });
  const [shortcuts, setShortcuts] = React.useState(false);

  const value = React.useMemo<ShellValue>(
    () => ({
      openPalette: (scope = null) =>
        setPalette((current) => ({ open: true, scope, session: current.open ? current.session : current.session + 1 })),
      openShortcuts: () => setShortcuts(true),
    }),
    [],
  );

  React.useEffect(() => {
    let pendingG = 0;
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPalette((current) => ({
          open: !current.open,
          scope: null,
          session: current.open ? current.session : current.session + 1,
        }));
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return;

      if (event.key === '?') {
        event.preventDefault();
        setShortcuts(true);
        return;
      }
      const key = event.key.toUpperCase();
      if (key === 'G') {
        pendingG = Date.now();
        return;
      }
      if (pendingG && Date.now() - pendingG < 1200) {
        pendingG = 0;
        const target = sections.find((section) => section.shortcut === key);
        if (target) {
          event.preventDefault();
          router.push(target.href as never);
        }
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [router, sections]);

  return (
    <ShellContext.Provider value={value}>
      {children}
      <CommandPalette
        key={palette.session}
        open={palette.open}
        scope={palette.scope}
        onOpenChange={(open) => setPalette((current) => ({ ...current, open, scope: open ? current.scope : null }))}
        onScopeChange={(scope) => setPalette((current) => ({ ...current, open: true, scope }))}
        sections={sections}
        commands={commands}
        onShowShortcuts={() => {
          setPalette((current) => ({ ...current, open: false, scope: null }));
          setShortcuts(true);
        }}
      />
      <ShortcutsDialog open={shortcuts} onOpenChange={setShortcuts} sections={sections} />
    </ShellContext.Provider>
  );
}

/** Un bouton qui ouvre la palette — le « Rechercher, lancer… » du rail, le « Déployer » de la vue d'ensemble. */
export function PaletteTrigger({
  scope = null,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<'button'>, 'onClick'> & { scope?: PaletteScope }) {
  const { openPalette } = useShell();
  return (
    <button type="button" className={className} onClick={() => openPalette(scope)} {...props}>
      {children}
    </button>
  );
}
