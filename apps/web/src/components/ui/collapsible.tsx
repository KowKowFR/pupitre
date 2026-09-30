'use client';

import * as React from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Dépliant. Un en-tête qu'on ouvre, un panneau qui apparaît dessous.
 *
 * **Un vrai `<button>`, pas un `<div onClick>`.** C'est ce qui donne
 * gratuitement le focus au clavier, l'activation à Entrée et à Espace, et le
 * rôle annoncé par un lecteur d'écran. `aria-expanded` dit l'état,
 * `aria-controls` désigne le panneau — les deux sont posés par le composant,
 * pas laissés à l'appelant qui les oublierait.
 *
 * Le déclencheur est **à côté** du contenu de l'en-tête, jamais autour : une
 * ligne de supervision porte des liens et des commandes, et imbriquer un lien
 * dans un bouton produit un balisage invalide que les navigateurs réparent
 * chacun à leur façon.
 *
 * Le panneau reste dans le document, masqué par `hidden` : le contenu est déjà
 * là, ouvrir ne déclenche aucun chargement et fermer ne perd rien.
 */

type CollapsibleContextValue = {
  open: boolean;
  toggle: () => void;
  triggerId: string;
  panelId: string;
};

const CollapsibleContext = React.createContext<CollapsibleContextValue | null>(null);

function useCollapsibleContext(component: string): CollapsibleContextValue {
  const context = React.useContext(CollapsibleContext);
  if (!context) {
    throw new Error(`<${component}> doit être rendu à l'intérieur de <Collapsible>`);
  }
  return context;
}

export function Collapsible({
  open,
  onOpenChange,
  defaultOpen = false,
  className,
  children,
}: {
  /** Passer `open` rend le composant contrôlé ; sinon il gère son propre état. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const id = React.useId();
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const isControlled = open !== undefined;
  const current = isControlled ? open : internalOpen;

  const toggle = React.useCallback(() => {
    const next = !current;
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  }, [current, isControlled, onOpenChange]);

  const value = React.useMemo<CollapsibleContextValue>(
    () => ({
      open: current,
      toggle,
      triggerId: `${id}-trigger`,
      panelId: `${id}-panel`,
    }),
    [current, id, toggle],
  );

  return (
    <CollapsibleContext.Provider value={value}>
      <div data-slot="collapsible" data-state={current ? 'open' : 'closed'} className={className}>
        {children}
      </div>
    </CollapsibleContext.Provider>
  );
}

/**
 * Le bouton qui ouvre. Le chevron pivote — un état qui se lit à la forme, pas
 * seulement à la couleur — et se fige sous `prefers-reduced-motion`.
 */
export function CollapsibleTrigger({
  className,
  children,
  disabled = false,
  ...props
}: React.ComponentProps<'button'>) {
  const { open, toggle, triggerId, panelId } = useCollapsibleContext('CollapsibleTrigger');

  return (
    <button
      {...props}
      type="button"
      id={triggerId}
      data-slot="collapsible-trigger"
      aria-expanded={open}
      aria-controls={panelId}
      disabled={disabled}
      onClick={toggle}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md text-left',
        'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        'disabled:pointer-events-none disabled:opacity-45',
        className,
      )}
    >
      <ChevronRight
        aria-hidden
        className={cn(
          'size-4 shrink-0 text-text-3 transition-transform duration-150 ease-out',
          'motion-reduce:transition-none',
          open && 'rotate-90',
        )}
      />
      {children}
    </button>
  );
}

/** Le panneau contrôlé par le déclencheur. Nommé par lui, pour les lecteurs d'écran. */
export function CollapsiblePanel({
  className,
  children,
  ...props
}: React.ComponentProps<'div'>) {
  const { open, triggerId, panelId } = useCollapsibleContext('CollapsiblePanel');

  return (
    <div
      {...props}
      id={panelId}
      data-slot="collapsible-panel"
      role="region"
      aria-labelledby={triggerId}
      hidden={!open}
    >
      <div className={className}>{children}</div>
    </div>
  );
}
