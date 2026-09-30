'use client';

import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Button, type ButtonProps } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Info-bulle — délai de 260 ms, fond graphite très sombre (clair en thème
 * sombre), 12/16, entrée en 120 ms. Elle peut porter un `Kbd`.
 *
 * Une info-bulle n'est **jamais** seule porteuse d'une information
 * indispensable : ce qu'elle dit doit se trouver aussi ailleurs (libellé
 * accessible, texte de la ligne, raison écrite sous un bouton).
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
 * Bouton icône : l'info-bulle et le `aria-label` sont **obligatoires** et
 * disent la même chose. Un bouton icône sans nom est un bouton que ni un
 * lecteur d'écran ni un nouveau venu ne sait lire.
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
