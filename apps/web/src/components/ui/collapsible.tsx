'use client';

import * as React from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A disclosure. A header one opens, a panel that appears underneath.
 *
 * **A real `<button>`, not a `<div onClick>`.** That is what gives for free the
 * keyboard focus, activation with Enter and Space, and the role announced by a
 * screen reader. `aria-expanded` says the state, `aria-controls` designates the
 * panel — both are set by the component, not left to the caller who would
 * forget them.
 *
 * The trigger is **next to** the header's content, never around it: a monitoring
 * row carries links and commands, and nesting a link in a button produces
 * invalid markup that browsers each repair in their own way.
 *
 * The panel stays in the document, hidden by `hidden`: the content is already
 * there, opening triggers no load and closing loses nothing.
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
    throw new Error(`<${component}> must be rendered inside <Collapsible>`);
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
  /** Passing `open` makes the component controlled; otherwise it manages its own state. */
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
 * The button that opens. The chevron rotates — a state that reads from the
 * shape, not only from the color — and freezes under `prefers-reduced-motion`.
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
        'outline-none focus-visible:shadow-focus',
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

/** The panel controlled by the trigger. Named by it, for screen readers. */
export function CollapsiblePanel({ className, children, ...props }: React.ComponentProps<'div'>) {
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
