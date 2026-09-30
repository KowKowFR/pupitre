'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Case à cocher — 16 px, coche blanche sur outremer, état mixte compris.
 *
 * Le natif porte déjà le clavier, le rôle et l'état `indeterminate` ; il ne
 * manque que l'apparence. `indeterminate` n'existe qu'en propriété DOM,
 * jamais en attribut : d'où le `ref` qui la repose à chaque changement.
 */
export type CheckboxProps = Omit<React.ComponentProps<'input'>, 'type'> & {
  indeterminate?: boolean;
};

function Checkbox({ className, indeterminate = false, ref, ...props }: CheckboxProps) {
  const inner = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (inner.current) inner.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      type="checkbox"
      data-slot="checkbox"
      ref={(node) => {
        inner.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      }}
      aria-checked={indeterminate ? 'mixed' : undefined}
      className={cn('cb', className)}
      {...props}
    />
  );
}

/**
 * Case et son libellé, avec une aide facultative dessous — la forme des
 * listes de permissions et des options de formulaire.
 */
function CheckboxField({
  label,
  help,
  className,
  ...props
}: CheckboxProps & { label: React.ReactNode; help?: React.ReactNode }) {
  return (
    <label className={cn('check', className)}>
      <Checkbox {...props} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="t-sm font-medium">{label}</span>
        {help ? <span className="help">{help}</span> : null}
      </span>
    </label>
  );
}

/**
 * Case présentée en pastille — les sept jours de la semaine, typiquement, où
 * une colonne de cases prendrait toute la largeur. Le natif porte l'état,
 * `has-[:checked]` porte le style.
 */
export type CheckboxChipProps = Omit<React.ComponentProps<'input'>, 'type'> & {
  label: React.ReactNode;
};

function CheckboxChip({ className, label, ...props }: CheckboxChipProps) {
  return (
    <label
      className={cn(
        'chip justify-center min-w-9 select-none',
        'has-[:checked]:border-accent-line has-[:checked]:bg-accent-soft has-[:checked]:text-accent-text',
        'has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50',
        'has-[:focus-visible]:shadow-focus',
        className,
      )}
    >
      <input type="checkbox" className="sr-only" {...props} />
      {label}
    </label>
  );
}

export { Checkbox, CheckboxField, CheckboxChip };
