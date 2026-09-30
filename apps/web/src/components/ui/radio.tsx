'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Choix exclusif présenté en segments.
 *
 * Écrit au-dessus de `<input type="radio">` natif, comme les autres primitives
 * du dossier : le navigateur fournit déjà la sémantique, la navigation aux
 * flèches et la restitution aux lecteurs d'écran. Le style se pose par
 * `has-[:checked]`, sans une ligne de JavaScript — un segment sélectionné n'est
 * pas un état React, c'est l'état du champ.
 */

function RadioGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      role="radiogroup"
      data-slot="radio-group"
      className={cn(
        'inline-flex w-fit gap-0.5 rounded-md border border-border-strong bg-surface-2 p-0.5',
        className,
      )}
      {...props}
    />
  );
}

export type RadioOptionProps = Omit<React.ComponentProps<'input'>, 'type'> & {
  label: React.ReactNode;
};

function RadioOption({ className, label, ...props }: RadioOptionProps) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center justify-center rounded-[5px] px-3 py-1',
        'text-[0.8125rem] font-medium text-text-2 select-none',
        'transition-[background-color,color] duration-100 ease-out',
        'hover:text-text',
        'has-[:checked]:bg-surface has-[:checked]:text-text has-[:checked]:shadow-xs',
        'has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-45 has-[:disabled]:hover:text-text-2',
        'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
        className,
      )}
    >
      <input type="radio" className="sr-only" {...props} />
      {label}
    </label>
  );
}

export { RadioGroup, RadioOption };
