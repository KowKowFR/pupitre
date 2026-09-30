'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Choix exclusif présenté en segments — le contrôle segmenté du kit, écrit
 * au-dessus de `<input type="radio">` natif : le navigateur fournit la
 * sémantique et la navigation aux flèches, `:has(:checked)` porte le style.
 * Un segment sélectionné n'est pas un état React, c'est l'état du champ.
 */
function RadioGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div role="radiogroup" data-slot="radio-group" className={cn('seg', className)} {...props} />
  );
}

export type RadioOptionProps = Omit<React.ComponentProps<'input'>, 'type'> & {
  label: React.ReactNode;
};

function RadioOption({ className, label, ...props }: RadioOptionProps) {
  return (
    <label className={className}>
      <input type="radio" className="sr-only" {...props} />
      {label}
    </label>
  );
}

/** Bouton radio classique, avec son libellé et une aide facultative. */
function Radio({
  label,
  help,
  className,
  ...props
}: Omit<React.ComponentProps<'input'>, 'type'> & {
  label: React.ReactNode;
  help?: React.ReactNode;
}) {
  return (
    <label className={cn('check', className)}>
      <input type="radio" className="rd" {...props} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="t-sm font-medium">{label}</span>
        {help ? <span className="help">{help}</span> : null}
      </span>
    </label>
  );
}

export { RadioGroup, RadioOption, Radio };
