'use client';

import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Button, type ButtonProps } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * A tooltip — 260 ms delay, very dark graphite background (light in the dark
 * theme), 12/16, entrance in 120 ms. It can carry a `Kbd`.
 *
 * A tooltip is **never** the only carrier of an indispensable piece of
 * information: what it says must also be found elsewhere (accessible label, the
 * row's text, a reason written under a button).
 */
const TooltipProvider = ({ children }: { children: React.ReactNode }) => (
  <TooltipPrimitive.Provider delayDuration={260} skipDelayDuration={200}>
    {children}
  </TooltipPrimitive.Provider>
);

function Tooltip({
  content,
  kbd,
  side = 'top',
  align = 'center',
  wide = false,
  children,
}: {
  content: React.ReactNode;
  kbd?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          align={align}
          sideOffset={7}
          collisionPadding={8}
          className={cn('tip', wide ? 'w-60 whitespace-normal' : 'whitespace-nowrap')}
        >
          {content}
          {kbd ? <kbd className="kbd">{kbd}</kbd> : null}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/**
 * An icon button: the tooltip and the `aria-label` are **required** and say the
 * same thing. An icon button without a name is a button neither a screen reader
 * nor a newcomer can read.
 */
function IconButton({
  label,
  kbd,
  side,
  variant = 'ghost',
  size = 'icon',
  children,
  ...props
}: Omit<ButtonProps, 'aria-label'> & {
  label: string;
  kbd?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <Tooltip content={label} kbd={kbd} side={side}>
      <Button variant={variant} size={size} aria-label={label} {...props}>
        {children}
      </Button>
    </Tooltip>
  );
}

export { TooltipProvider, Tooltip, IconButton };
