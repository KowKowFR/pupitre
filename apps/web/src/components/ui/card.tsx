import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Carte. Surface blanche, filet et ombre `xs`, rayon 12 : la hiérarchie se lit
 * au contraste des surfaces, pas à la profondeur.
 *
 * Anatomie du kit : un en-tête (`CardHeader`) séparé par un filet, un corps
 * (`CardContent`, 16 px), un pied (`CardFooter`) sur `surface-2`. Une liste
 * ou un tableau se pose directement dans la carte, sans corps, pour que ses
 * lignes touchent les bords.
 */
function Card({ className, ...props }: React.ComponentProps<'section'>) {
  return <section data-slot="card" className={cn('card', className)} {...props} />;
}

/**
 * En-tête de carte : titre et sous-titre empilés à gauche, actions à droite
 * (`actions`), séparés du corps par un filet.
 */
function CardHeader({
  className,
  actions,
  children,
  ...props
}: React.ComponentProps<'div'> & { actions?: React.ReactNode }) {
  return (
    <div data-slot="card-header" className={cn('card-h flex-wrap', className)} {...props}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">{children}</div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<'h2'>) {
  return <h2 data-slot="card-title" className={cn('min-w-0', className)} {...props} />;
}

function CardDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return <p data-slot="card-description" className={cn('sub', className)} {...props} />;
}

function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-content" className={cn('card-b', className)} {...props} />;
}

/** Pied de carte, sur `surface-2` — pagination, actions secondaires, note. */
function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-footer" className={cn('card-f', className)} {...props} />;
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
