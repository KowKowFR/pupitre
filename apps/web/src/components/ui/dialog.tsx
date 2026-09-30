'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '@/lib/utils';

/**
 * Dialogue — 460 px (560 en `wide`), voile à 28 % flouté de 2 px, entrée
 * `pp-dialog` en 240 ms, sortie en 160 ms.
 *
 * Radix porte ce qu'une modale ne peut pas faire à moitié : piège du focus,
 * `Escape`, restitution du focus au déclencheur, inertie du reste de la page.
 * Les animations passent par `data-state`, donc Radix attend la fin de la
 * sortie avant de démonter.
 *
 * Anatomie du kit : un en-tête (icône de ton facultative, titre qui est une
 * question), un corps qui seul défile, un pied sur `surface-2` avec
 * « Annuler » puis le verbe. Pas de croix : on sort par Annuler ou par Échap.
 */

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;
const DialogPortal = DialogPrimitive.Portal;

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn('scrim blur', className)}
      {...props}
    />
  );
}

function DialogContent({
  className,
  size = 'default',
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  size?: 'default' | 'wide' | 'xwide';
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        // Radix pose `aria-hidden` sur les frères de la modale ; `aria-modal`
        // le dit en plus sur la boîte elle-même. Les deux sont attendus.
        aria-modal="true"
        className={cn('dialog', size === 'wide' && 'is-wide', size === 'xwide' && 'is-xwide', className)}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

export type DialogTone = 'danger' | 'warn' | 'accent';

/** En-tête : cartouche d'icône facultatif, puis le titre et sa description. */
function DialogHeader({
  className,
  icon,
  tone = 'danger',
  children,
  ...props
}: React.ComponentProps<'div'> & { icon?: React.ReactNode; tone?: DialogTone }) {
  return (
    <div data-slot="dialog-header" className={cn('dlg-h', className)} {...props}>
      {icon ? (
        <span aria-hidden className={cn('dlg-icon', tone === 'warn' && 'is-warn', tone === 'accent' && 'is-accent')}>
          {icon}
        </span>
      ) : null}
      <div className={cn('flex min-w-0 flex-col gap-1', icon && 'pt-1.5')}>{children}</div>
    </div>
  );
}

/** Le corps est la seule zone qui défile. */
function DialogBody({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="dialog-body" className={cn('dlg-b', className)} {...props} />;
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="dialog-footer" className={cn('dlg-f', className)} {...props} />;
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('text-[17px] leading-6 font-semibold tracking-[-0.01em] text-text', className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-[13.5px] leading-5 text-text-2', className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
