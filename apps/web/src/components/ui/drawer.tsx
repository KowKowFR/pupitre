'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ArrowUpRight, ChevronDown, ChevronUp, Maximize2, X } from 'lucide-react';
import { IconButton } from '@/components/ui/tooltip';
import { useT } from '@/i18n/client';
import { chrome } from '@/i18n/messages/chrome';
import {
  drawerKeyAction,
  hrefWithSelection,
  isTyping,
  neighbour,
  selectionFrom,
} from '@/lib/drawer-url';
import { cn } from '@/lib/utils';

/**
 * A drawer — the overview that opens from a list row, without leaving the page.
 * Long work, for its part, is done on the detail page: the drawer does not
 * replace it, it leads there ("Open the record").
 *
 * The kit's geometry: a panel on the right, 8 px inset, 540 px (680 in `wide`),
 * radius 14, `lg` shadow. A light veil on the content only, the rail stays
 * visible. Entrance in 320 ms (48 px and fade), exit in 200 ms; the body's
 * sections appear in cascade. Under `lg`, a rising sheet.
 *
 * Keyboard: Escape closes, J and K move to the next and previous row, Enter opens
 * the record. On top of Radix Dialog: focus trap, `aria-modal`, focus restored
 * to the original row.
 */

type DrawerNav = {
  onPrevious?: () => void;
  onNext?: () => void;
  recordHref?: string;
};

const DrawerContext = React.createContext<DrawerNav>({});

export function Drawer({
  open,
  onOpenChange,
  wide = false,
  xwide = false,
  onPrevious,
  onNext,
  recordHref,
  label,
  children,
}: DrawerNav & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wide?: boolean;
  /** An object's record, with its tabs: the width of a reading page. */
  xwide?: boolean;
  /** Accessible name, when the visible title is not enough. */
  label?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const nav = React.useMemo(
    () => ({ onPrevious, onNext, recordHref }),
    [onPrevious, onNext, recordHref],
  );

  function onKeyDown(event: React.KeyboardEvent) {
    const action = drawerKeyAction(
      {
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        tag: (event.target as HTMLElement).tagName?.toLowerCase(),
        typing: isTyping(event.target),
      },
      {
        canPrevious: Boolean(onPrevious),
        canNext: Boolean(onNext),
        hasRecord: Boolean(recordHref),
      },
    );
    if (action === null) return;
    event.preventDefault();
    if (action === 'next') onNext?.();
    else if (action === 'previous') onPrevious?.();
    else if (recordHref) router.push(recordHref as never);
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="scrim soft is-content" />
        <DialogPrimitive.Content
          aria-modal="true"
          aria-label={label}
          aria-describedby={undefined}
          tabIndex={-1}
          className={cn(
            'drawer outline-none focus-visible:shadow-lg',
            wide && 'is-wide',
            xwide && 'is-xwide',
          )}
          onKeyDown={onKeyDown}
          // The focus goes to the panel, not to its first button: otherwise the
          // "Previous" tooltip would open at each overview, and a screen reader would
          // announce a button instead of the target.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus();
          }}
        >
          <DrawerContext.Provider value={nav}>{children}</DrawerContext.Provider>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * Header: the context line (icon, type, route in mono) and its buttons —
 * previous, next, full page, close —, the title in 20/28, then a state line.
 */
export function DrawerHeader({
  icon,
  kind,
  route,
  title,
  state,
  extra,
}: {
  icon?: React.ReactNode;
  kind: React.ReactNode;
  route?: string;
  title: React.ReactNode;
  state?: React.ReactNode;
  extra?: React.ReactNode;
}) {
  const t = useT(chrome);
  const { onPrevious, onNext, recordHref } = React.useContext(DrawerContext);
  return (
    <div className="dr-h">
      <div className="dr-ctx">
        {icon ? <span className="flex text-text-3">{icon}</span> : null}
        <span className="shrink-0">{kind}</span>
        {route ? <span className="mono truncate text-[11.5px] text-text-3">{route}</span> : null}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {onPrevious !== undefined || onNext !== undefined ? (
            <>
              <IconButton
                label={t('drawer.previous')}
                kbd="K"
                size="icon-sm"
                disabled={!onPrevious}
                onClick={onPrevious}
              >
                <ChevronUp />
              </IconButton>
              <IconButton
                label={t('drawer.next')}
                kbd="J"
                size="icon-sm"
                disabled={!onNext}
                onClick={onNext}
              >
                <ChevronDown />
              </IconButton>
            </>
          ) : null}
          {recordHref ? (
            <IconButton label={t('drawer.expand')} size="icon-sm" asChild>
              <Link href={recordHref as never}>
                <Maximize2 />
              </Link>
            </IconButton>
          ) : null}
          <DialogPrimitive.Close asChild>
            <IconButton label={t('drawer.close')} kbd="esc" size="icon-sm">
              <X />
            </IconButton>
          </DialogPrimitive.Close>
        </span>
      </div>
      <DialogPrimitive.Title className="t-drawer min-w-0 break-words">
        {title}
      </DialogPrimitive.Title>
      {state ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px]">{state}</div>
      ) : null}
      {extra}
    </div>
  );
}

/** The body scrolls; each direct child enters in cascade (40 ms apart). */
export function DrawerBody({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('dr-b', className)} {...props} />;
}

export function DrawerSection({
  title,
  aside,
  className,
  children,
}: {
  title: React.ReactNode;
  aside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn('dr-sec', className)}>
      <h3>
        {title}
        {aside}
      </h3>
      {children}
    </section>
  );
}

/**
 * The sensitive zone, at the bottom of the body: that is where deletions live.
 * The button there is outlined, and it opens a dialog — never a direct action.
 */
export function DrawerDanger({ children }: { children: React.ReactNode }) {
  const t = useT(chrome);
  return (
    <section className="dr-sec rounded-[10px] border border-danger-line p-3.5">
      <h3 className="text-danger-text">{t('drawer.danger')}</h3>
      {children}
    </section>
  );
}

/**
 * Footer: the primary action first, the secondary next. On the right, the "Open
 * the record" link — or, when the record is already a footer action, what the
 * caller puts there (`end`, typically a deletion).
 */
export function DrawerFooter({ children, end }: { children?: React.ReactNode; end?: React.ReactNode }) {
  const t = useT(chrome);
  const { recordHref } = React.useContext(DrawerContext);
  return (
    <div className="dr-f">
      {children}
      {end !== undefined ? (
        <span className="ml-auto flex items-center gap-2">{end}</span>
      ) : recordHref ? (
        <Link href={recordHref as never} className="btn btn-ghost ml-auto">
          {t('drawer.record')}
          <ArrowUpRight aria-hidden />
        </Link>
      ) : null}
    </div>
  );
}

/**
 * A drawer's selection, synchronized with the URL under `key`.
 *
 * Opening **adds** a history entry: the Back button closes. Moving from one row
 * to another (J/K) and closing **replace** the entry, so as not to fill the
 * history with each hovered row. The native history API is integrated into
 * Next's router: `useSearchParams` follows, without fetching the page from the
 * server again.
 */
export function useDrawerSelection(key: string, ids?: readonly string[]) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selected = selectionFrom(searchParams, key);

  const select = React.useCallback(
    (id: string | null, mode: 'push' | 'replace' = id === null ? 'replace' : 'push') => {
      const href = hrefWithSelection(pathname, window.location.search, key, id);
      if (mode === 'push') window.history.pushState(null, '', href);
      else window.history.replaceState(null, '', href);
    },
    [key, pathname],
  );

  const previous = ids ? neighbour(ids, selected, -1) : null;
  const next = ids ? neighbour(ids, selected, 1) : null;

  return {
    selected,
    select,
    open: (id: string) => select(id, selected === null ? 'push' : 'replace'),
    close: () => select(null),
    onPrevious:
      previous !== null && selected !== null ? () => select(previous, 'replace') : undefined,
    onNext: next !== null && selected !== null ? () => select(next, 'replace') : undefined,
  };
}
