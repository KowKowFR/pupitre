'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { CommandKey, SectionKey } from '@/lib/navigation';
import { isTyping } from '@/lib/drawer-url';
import { CommandPalette } from './command-palette';
import { ShortcutsDialog } from './shortcuts-dialog';

/**
 * The shell, client side: the state of the ⌘K palette and of the shortcuts help,
 * and listening to the global shortcuts.
 *
 * - ⌘K / Ctrl K: open or close the palette, from anywhere;
 * - `G` then a letter: go to a section (D, C, A, P, S);
 * - `?`: show the list of shortcuts.
 *
 * The single-letter shortcuts go quiet during an input and when a layer (dialog,
 * drawer) is open: they must never steal a keystroke from the operator.
 */

export type PaletteScope = 'deploy' | null;

type ShellValue = {
  openPalette: (scope?: PaletteScope) => void;
  openShortcuts: () => void;
  /** Registers a single-letter shortcut specific to the screen; returns its remover. */
  registerHotkey: (key: string, handler: () => void) => () => void;
};

const ShellContext = React.createContext<ShellValue>({
  openPalette: () => undefined,
  openShortcuts: () => undefined,
  registerHotkey: () => () => undefined,
});

/**
 * A single-letter shortcut for a screen's primary action ("D" for Deploy on the
 * overview). It always gives way to the `G` then a letter sequence, and goes
 * quiet during an input like the others.
 */
export function useHotkey(key: string, handler: () => void, enabled = true): void {
  const { registerHotkey } = React.useContext(ShellContext);
  const latest = React.useRef(handler);
  React.useEffect(() => {
    latest.current = handler;
  });
  React.useEffect(() => {
    if (!enabled) return;
    return registerHotkey(key.toUpperCase(), () => latest.current());
  }, [enabled, key, registerHotkey]);
}

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
  // `session` changes at each opening: the palette is mounted again, and starts
  // again from an empty input without a reset effect.
  const [palette, setPalette] = React.useState<{
    open: boolean;
    scope: PaletteScope;
    session: number;
  }>({
    open: false,
    scope: null,
    session: 0,
  });
  const [shortcuts, setShortcuts] = React.useState(false);
  const hotkeys = React.useRef(new Map<string, () => void>());

  const value = React.useMemo<ShellValue>(
    () => ({
      openPalette: (scope = null) =>
        setPalette((current) => ({
          open: true,
          scope,
          session: current.open ? current.session : current.session + 1,
        })),
      openShortcuts: () => setShortcuts(true),
      registerHotkey: (key, handler) => {
        hotkeys.current.set(key, handler);
        return () => {
          if (hotkeys.current.get(key) === handler) hotkeys.current.delete(key);
        };
      },
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
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
        )
      )
        return;

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
        return;
      }
      const hotkey = hotkeys.current.get(key);
      if (hotkey) {
        event.preventDefault();
        hotkey();
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
        onOpenChange={(open) =>
          setPalette((current) => ({ ...current, open, scope: open ? current.scope : null }))
        }
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

/** A button that opens the palette — the rail's "Search, run…", the overview's "Deploy". */
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
