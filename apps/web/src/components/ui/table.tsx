import * as React from 'react';
import { cn } from '@/lib/utils';
import { TableScroller } from './table-scroller';

/**
 * Tableau du kit : en-tête de 36 px sur `surface-2`, lignes de 48 px (40 en
 * `dense`), texte à 13 px. Une ligne cliquable (`interactive`) prend le fond
 * `surface-2` au survol ; une ligne sélectionnée prend l'outremer doux et un
 * liseré gauche de 2 px.
 */
function Table({
  className,
  label,
  dense = false,
  ...props
}: React.ComponentProps<'table'> & { label?: string; dense?: boolean }) {
  return (
    <TableScroller label={label}>
      <table data-slot="table" className={cn('tbl', dense && 'dense', className)} {...props} />
    </TableScroller>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={className} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" className={className} {...props} />;
}

function TableRow({
  className,
  interactive = false,
  selected = false,
  ...props
}: React.ComponentProps<'tr'> & { interactive?: boolean; selected?: boolean }) {
  return (
    <tr
      data-slot="table-row"
      aria-selected={selected || undefined}
      className={cn('group/row', interactive && 'is-link', selected && 'is-sel', className)}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return <th data-slot="table-head" className={className} {...props} />;
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return <td data-slot="table-cell" className={className} {...props} />;
}

/**
 * Cellule d'actions, épinglée au bord droit du conteneur défilant.
 *
 * Une colonne d'actions est la seule dont on ne peut pas se passer : on peut
 * lire un tableau sans voir la date, on ne peut pas cliquer un bouton qu'on ne
 * voit pas. `position: sticky` est inerte tant que rien ne déborde.
 *
 * Le fond est peint explicitement, sans quoi les colonnes défileraient
 * visiblement dessous ; il suit le survol et la sélection de sa ligne. Le
 * filet et l'ombre n'apparaissent que si quelque chose est réellement caché
 * dessous — d'où la lecture de `data-more-right`, posé par `TableScroller`.
 */
function TableActions({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <td
      data-slot="table-actions"
      className={cn(
        'sticky right-0 z-10 bg-surface text-right',
        '[tr.is-link:hover_&]:bg-surface-2 [tr.is-sel_&]:bg-accent-soft',
        'transition-shadow duration-150',
        '[[data-more-right]_&]:shadow-[-10px_0_10px_-10px_rgba(0,0,0,0.35)]',
        '[[data-more-right]_&]:before:absolute [[data-more-right]_&]:before:inset-y-0',
        '[[data-more-right]_&]:before:left-0 [[data-more-right]_&]:before:w-px',
        '[[data-more-right]_&]:before:bg-border',
        className,
      )}
      {...props}
    />
  );
}

/** Son en-tête. Épinglé pour la même raison, et pour rester au-dessus de sa colonne. */
function TableActionsHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-actions-head"
      className={cn(
        'r sticky right-0 z-10',
        '[[data-more-right]_&]:before:absolute [[data-more-right]_&]:before:inset-y-0',
        '[[data-more-right]_&]:before:left-0 [[data-more-right]_&]:before:w-px',
        '[[data-more-right]_&]:before:bg-border',
        className,
      )}
      {...props}
    />
  );
}

export {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableActions,
  TableActionsHead,
};
