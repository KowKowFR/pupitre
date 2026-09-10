'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '@/lib/utils';

/**
 * Modale accessible, au-dessus de `@radix-ui/react-dialog`.
 *
 * Les autres composants `ui/` de ce projet sont écrits à la main, sans Radix.
 * Une modale ne peut pas l'être honnêtement : piège de focus, `Escape`,
 * `aria-modal`, restitution du focus au déclencheur et inertie du reste de la
 * page sont un travail à part entière, et le faire à moitié donne une boîte qui
 * *ressemble* à une modale sans en être une au clavier.
 *
 * `DialogContent` est une colonne : en-tête et pied ne bougent pas, seul
 * `DialogBody` défile. Les animations sont neutralisées sous
 * `prefers-reduced-motion`.
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
      className={cn(
        // Le voile est pris sur les jetons, jamais littéral : le neutre le plus
        // sombre du thème clair, le fond le plus profond du thème sombre.
        'dark:bg-background/80 bg-foreground/50 fixed inset-0 z-50',
        'data-[state=open]:animate-in data-[state=open]:fade-in-0',
        'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
        // `!` est nécessaire : la variante `data-[state=…]` de tw-animate-css a
        // une spécificité supérieure et l'emporterait sur une simple
        // neutralisation.
        'motion-reduce:animate-none!',
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        // Radix rend déjà le reste de la page invisible aux lecteurs d'écran en
        // posant `aria-hidden` sur les frères de la modale. `aria-modal` le dit
        // en plus sur la boîte elle-même : les deux mécanismes sont attendus, et
        // Radix ne pose que le premier.
        aria-modal="true"
        className={cn(
          // Même surface qu'une `Card` : en thème sombre, le fond de page et la
          // surface d'un panneau ne sont pas la même couleur, et une modale doit
          // se détacher de la page qu'elle recouvre.
          'bg-card text-card-foreground fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-[calc(100%-2rem)] max-w-2xl',
          '-translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border shadow-lg',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          // `!` est nécessaire : la variante `data-[state=…]` de tw-animate-css a
          // une spécificité supérieure et l'emporterait sur une simple
          // neutralisation.
          'motion-reduce:animate-none!',
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          data-slot="dialog-close"
          className="ring-offset-background focus-visible:ring-ring/50 absolute top-4 right-4 rounded-md p-1 opacity-70 transition-opacity outline-none hover:opacity-100 focus-visible:ring-[3px] motion-reduce:transition-none!"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            className="size-4"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
          <span className="sr-only">Fermer</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex shrink-0 flex-col gap-1.5 border-b px-6 py-4 pr-12', className)}
      {...props}
    />
  );
}

/** Le corps est la seule zone qui défile. */
function DialogBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-body"
      className={cn('min-h-0 flex-1 overflow-y-auto px-6 py-4', className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        'flex shrink-0 flex-col-reverse gap-2 border-t px-6 py-4 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('text-lg leading-none font-semibold', className)}
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
      className={cn('text-muted-foreground text-sm', className)}
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
