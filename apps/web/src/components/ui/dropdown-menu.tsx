'use client';

import * as React from 'react';
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Menu — rayon 11, ombre `md`, entrée `pp-pop` en 180 ms. Les items font
 * 32 px, avec un raccourci ou une méta à droite. Un item destructif est rouge
 * et placé en dernier, après un séparateur.
 */
const DropdownMenu = MenuPrimitive.Root;
const DropdownMenuTrigger = MenuPrimitive.Trigger;
const DropdownMenuGroup = MenuPrimitive.Group;
const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup;

function DropdownMenuContent({
  className,
  sideOffset = 6,
  align = 'start',
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        className={cn('menu', className)}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

function DropdownMenuItem({
  className,
  destructive = false,
  meta,
  children,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Item> & { destructive?: boolean; meta?: React.ReactNode }) {
  return (
    <MenuPrimitive.Item className={cn('menu-item', destructive && 'is-danger', className)} {...props}>
      {children}
      {meta ? <span className="meta">{meta}</span> : null}
    </MenuPrimitive.Item>
  );
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem className={cn('menu-item', className)} {...props}>
      {children}
      <MenuPrimitive.ItemIndicator className="ml-auto flex">
        <Check aria-hidden className="!text-accent" />
      </MenuPrimitive.ItemIndicator>
    </MenuPrimitive.RadioItem>
  );
}

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn('menu-sep', className)} {...props} />;
}

function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Label>) {
  return <MenuPrimitive.Label className={cn('menu-label', className)} {...props} />;
}

const DropdownMenuSub = MenuPrimitive.Sub;

function DropdownMenuSubTrigger({
  className,
  children,
  meta,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.SubTrigger> & { meta?: React.ReactNode }) {
  return (
    <MenuPrimitive.SubTrigger className={cn('menu-item', className)} {...props}>
      {children}
      {meta ? <span className="meta">{meta}</span> : null}
    </MenuPrimitive.SubTrigger>
  );
}

function DropdownMenuSubContent({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.SubContent>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.SubContent sideOffset={6} collisionPadding={8} className={cn('menu', className)} {...props} />
    </MenuPrimitive.Portal>
  );
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuGroup,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
