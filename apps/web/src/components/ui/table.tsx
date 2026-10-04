import * as React from 'react';
import { cn } from '@/lib/utils';
import { TableScroller } from './table-scroller';

/**
 * The kit's table: a 36 px header on `surface-2`, 48 px rows (40 in `dense`),
 * 13 px text. A clickable row (`interactive`) takes the `surface-2` background on
 * hover; a selected row takes the soft ultramarine and a 2 px left border.
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
 * An actions cell, pinned to the scrolling container's right edge.
 *
 * An actions column is the only one one cannot do without: one can read a table
 * without seeing the date, one cannot click a button one does not see.
 * `position: sticky` is inert as long as nothing overflows.
 *
 * The background is painted explicitly, otherwise the columns would visibly
 * scroll underneath; it follows its row's hover and selection. The rule and the
 * shadow only appear if something is really hidden underneath — hence reading
 * `data-more-right`, set by `TableScroller`.
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

/** Its header. Pinned for the same reason, and to stay above its column. */
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
