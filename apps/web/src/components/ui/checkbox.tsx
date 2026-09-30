'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Case à cocher présentée en pastille.
 *
 * Même parti pris que `radio.tsx` : le champ natif porte l'état et la
 * sémantique, `has-[:checked]` porte le style. Utile partout où un choix
 * multiple tient en quelques valeurs courtes — les sept jours de la semaine,
 * typiquement — et où une colonne de cases prendrait toute la largeur.
 */
export type CheckboxChipProps = Omit<React.ComponentProps<'input'>, 'type'> & {
  label: React.ReactNode;
};

function CheckboxChip({ className, label, ...props }: CheckboxChipProps) {
  return (
    <label
      className={cn(
        'flex h-8 min-w-9 cursor-pointer items-center justify-center rounded-md px-2',
        'border border-border-strong bg-surface',
        'text-[0.8125rem] font-medium text-text-2 select-none',
        'transition-[background-color,border-color,color] duration-100 ease-out',
        'hover:border-text-3/60',
        'has-[:checked]:border-accent-line has-[:checked]:bg-accent-soft has-[:checked]:text-text',
        'has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-45',
        'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
        className,
      )}
    >
      <input type="checkbox" className="sr-only" {...props} />
      {label}
    </label>
  );
}

export { CheckboxChip };

/**
 * Case à cocher nue, sans libellé attenant — celle des colonnes de sélection
 * d'un tableau, où l'étiquette est la ligne elle-même (`aria-label`).
 *
 * Le natif porte déjà le clavier, le rôle et l'état `indeterminate` ; il ne
 * manque que l'apparence, d'où `appearance-none` et une coche en image de fond
 * plutôt qu'un enfant à styler.
 *
 * `indeterminate` n'existe qu'en propriété DOM, jamais en attribut : d'où le
 * `ref` qui la repose à chaque changement.
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
      className={cn(
        'size-4 shrink-0 cursor-pointer appearance-none rounded-[0.25rem] border border-border-strong bg-surface',
        'transition-[background-color,border-color] duration-100 ease-out',
        'hover:border-accent-line',
        'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        'disabled:cursor-not-allowed disabled:opacity-45',
        'checked:border-accent checked:bg-accent checked:bg-center checked:bg-no-repeat',
        "checked:bg-[url(\"data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='white' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m3.5 8.5 3 3 6-6'/%3E%3C/svg%3E\")]",
        'indeterminate:border-accent indeterminate:bg-accent indeterminate:bg-center indeterminate:bg-no-repeat',
        "indeterminate:bg-[url(\"data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='white' stroke-width='2.5' stroke-linecap='round'%3E%3Cpath d='M4 8h8'/%3E%3C/svg%3E\")]",
        className,
      )}
      {...props}
    />
  );
}

export { Checkbox };
