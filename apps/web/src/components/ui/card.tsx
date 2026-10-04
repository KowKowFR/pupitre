import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A card. A white surface, a rule and an `xs` shadow, radius 12: the hierarchy
 * reads from the surfaces' contrast, not from depth.
 *
 * The kit's anatomy: a header (`CardHeader`) separated by a rule, a body
 * (`CardContent`, 16 px), a footer (`CardFooter`) on `surface-2`. A list or a
 * table sits directly in the card, without a body, so that its rows touch the
 * edges.
 */
function Card({ className, ...props }: React.ComponentProps<'section'>) {
  return <section data-slot="card" className={cn('card', className)} {...props} />;
}

/**
 * A card header: title and subtitle stacked on the left, actions on the right
 * (`actions`), separated from the body by a rule.
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

/** Card footer, on `surface-2` — pagination, secondary actions, note. */
function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-footer" className={cn('card-f', className)} {...props} />;
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
