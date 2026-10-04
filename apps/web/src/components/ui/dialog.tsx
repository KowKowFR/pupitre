'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '@/lib/utils';

/**
 * A dialog — 460 px (560 in `wide`), 28% veil blurred by 2 px, `pp-dialog`
 * entrance in 240 ms, exit in 160 ms.
 *
 * Radix carries what a modal cannot do halfway: focus trap, `Escape`, focus
 * restored to the trigger, inertness of the rest of the page. The animations go
 * through `data-state`, so Radix waits for the exit to end before unmounting.
 *
 * The kit's anatomy: a header (optional tone icon, a title that is a question), a
 * body that alone scrolls, a footer on `surface-2` with "Cancel" then the verb.
 * No cross: one leaves through Cancel or Escape.
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
        // Radix sets `aria-hidden` on the modal's siblings; `aria-modal` also says it on
        // the box itself. Both are expected.
        aria-modal="true"
        className={cn(
          'dialog',
          size === 'wide' && 'is-wide',
          size === 'xwide' && 'is-xwide',
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

export type DialogTone = 'danger' | 'warn' | 'accent';

/** Header: optional icon cartouche, then the title and its description. */
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
        <span
          aria-hidden
          className={cn('dlg-icon', tone === 'warn' && 'is-warn', tone === 'accent' && 'is-accent')}
        >
          {icon}
        </span>
      ) : null}
      <div className={cn('flex min-w-0 flex-col gap-1', icon && 'pt-1.5')}>{children}</div>
    </div>
  );
}

/** The body is the only area that scrolls. */
function DialogBody({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="dialog-body" className={cn('dlg-b', className)} {...props} />;
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="dialog-footer" className={cn('dlg-f', className)} {...props} />;
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
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
