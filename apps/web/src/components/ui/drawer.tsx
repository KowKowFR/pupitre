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
 * Drawer — l'aperçu qui s'ouvre depuis une ligne de liste, sans quitter la
 * page. Le travail long, lui, se fait sur la page de détail : le drawer ne la
 * remplace pas, il y mène (« Ouvrir la fiche »).
 *
 * Géométrie du kit : panneau à droite, inset de 8 px, 540 px (680 en `wide`),
 * rayon 14, ombre `lg`. Voile léger sur le contenu seulement, le rail reste
 * visible. Entrée en 320 ms (48 px et fondu), sortie en 200 ms ; les
 * sections du corps apparaissent en cascade. Sous `lg`, feuille montante.
 *
 * Clavier : Échap ferme, J et K passent à la ligne suivante et précédente,
 * Entrée ouvre la fiche. Au-dessus de Radix Dialog : piège du focus,
 * `aria-modal`, restitution du focus à la ligne d'origine.
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
  onPrevious,
  onNext,
  recordHref,
  label,
  children,
}: DrawerNav & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wide?: boolean;
  /** Nom accessible, quand le titre visible ne suffit pas. */
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
          className={cn('drawer outline-none focus-visible:shadow-lg', wide && 'is-wide')}
          onKeyDown={onKeyDown}
          // Le focus va au panneau, pas à son premier bouton : sinon l'info-bulle
          // de « Précédent » s'ouvrirait à chaque aperçu, et un lecteur d'écran
          // annoncerait un bouton au lieu de la cible.
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
 * En-tête : la ligne de contexte (icône, type, route en mono) et ses boutons
 * — précédent, suivant, pleine page, fermer —, le titre en 20/28, puis une
 * ligne d'état.
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

/** Le corps défile ; chaque enfant direct entre en cascade (40 ms d'écart). */
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
 * Zone sensible, en bas du corps : c'est là que vivent les suppressions. Le
 * bouton y est au trait, et il ouvre un dialogue — jamais une action directe.
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
 * Pied : l'action primaire d'abord, la secondaire ensuite. À droite, le lien
 * « Ouvrir la fiche » — ou, quand la fiche est déjà une action du pied, ce que
 * l'appelant y pose (`end`, typiquement une suppression).
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
 * La sélection d'un drawer, synchronisée avec l'URL sous `key`.
 *
 * Ouvrir **ajoute** une entrée d'historique : le bouton Précédent referme.
 * Passer d'une ligne à l'autre (J/K) et fermer **remplacent** l'entrée, pour
 * ne pas remplir l'historique de chaque ligne survolée. L'API d'historique
 * native est intégrée au routeur de Next : `useSearchParams` suit, sans aller
 * rechercher la page au serveur.
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
