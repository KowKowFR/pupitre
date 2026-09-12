import * as React from 'react';
import { cn } from '@/lib/utils';
import { TableScroller } from './table-scroller';

function Table({
  className,
  label,
  ...props
}: React.ComponentProps<'table'> & { label?: string }) {
  return (
    <TableScroller label={label}>
      <table
        data-slot="table"
        className={cn('w-full caption-bottom border-collapse text-sm', className)}
        {...props}
      />
    </TableScroller>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return (
    <thead
      data-slot="table-header"
      className={cn('[&_tr]:border-b [&_tr]:border-line-strong', className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return (
    <tbody
      data-slot="table-body"
      className={cn('[&_tr:last-child]:border-0', className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        // `group/row` sert aux cellules épinglées, qui doivent suivre le survol
        // de leur ligne alors qu'elles ne sont pas survolées elles-mêmes.
        'group/row border-b border-line transition-colors duration-100 hover:bg-row-hover',
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'eyebrow h-8 px-3 text-left align-middle whitespace-nowrap text-ink-faint',
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <td data-slot="table-cell" className={cn('px-3 py-2.5 align-middle', className)} {...props} />
  );
}

/**
 * Cellule d'actions, épinglée au bord droit du conteneur défilant.
 *
 * Une colonne d'actions est la seule dont on ne peut pas se passer : on peut
 * lire un tableau sans voir la date, on ne peut pas cliquer un bouton qu'on ne
 * voit pas. `position: sticky` est inerte tant que rien ne déborde — sur un
 * écran large, la cellule se comporte exactement comme une `TableCell`.
 *
 * Le fond est peint explicitement, sans quoi les colonnes défileraient
 * visiblement dessous. `--row-hover` est un mélange et non une transparence :
 * la cellule recouvre le fond de survol de sa propre ligne et doit en peindre
 * la couleur exacte, ce qu'une superposition d'alpha ne donnerait pas.
 *
 * Le filet et l'ombre n'apparaissent que si quelque chose est réellement caché
 * dessous — d'où la lecture de `data-more-right`, posé par `TableScroller`.
 */
function TableActions({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <td
      data-slot="table-actions"
      className={cn(
        'sticky right-0 z-10 bg-card px-3 py-2.5 text-right align-middle',
        'group-hover/row:bg-row-hover',
        // Repli visuel du bord épinglé, uniquement quand il masque du contenu.
        'transition-shadow duration-150',
        '[[data-more-right]_&]:shadow-[-10px_0_10px_-10px_oklch(0_0_0/0.45)]',
        '[[data-more-right]_&]:before:absolute [[data-more-right]_&]:before:inset-y-0',
        '[[data-more-right]_&]:before:left-0 [[data-more-right]_&]:before:w-px',
        '[[data-more-right]_&]:before:bg-line',
        className,
      )}
      {...props}
    />
  );
}

/**
 * Son en-tête. Épinglé pour la même raison, et pour que le titre reste
 * au-dessus de sa colonne quand on fait défiler.
 */
function TableActionsHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-actions-head"
      className={cn(
        'eyebrow sticky right-0 z-10 h-8 bg-card px-3 text-right align-middle whitespace-nowrap text-ink-faint',
        // Le filet du bord épinglé traverse aussi l'en-tête : interrompu à la
        // première ligne, il ressemblerait à une bordure de tableau ratée.
        '[[data-more-right]_&]:before:absolute [[data-more-right]_&]:before:inset-y-0',
        '[[data-more-right]_&]:before:left-0 [[data-more-right]_&]:before:w-px',
        '[[data-more-right]_&]:before:bg-line',
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
