import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Pastille d'état. Chaque variante sémantique est un triplet fond doux /
 * liseré / texte pris dans les jetons : elle tient donc dans les deux thèmes
 * sans utilitaire `dark:`.
 */
const badgeVariants = cva(
  [
    'inline-flex w-fit shrink-0 items-center justify-center gap-1 whitespace-nowrap',
    'rounded-sm border px-1.5 py-0.5 text-[0.6875rem] leading-4 font-medium',
    '[&>svg]:size-3',
  ],
  {
    variants: {
      variant: {
        default: 'border-accent-line bg-accent-soft text-accent',
        secondary: 'border-border bg-surface-2 text-text-2',
        outline: 'border-border-strong bg-transparent text-text-2',
        solid: 'border-transparent bg-accent text-accent-fg',
        ok: 'border-ok-line bg-ok-soft text-ok-text',
        warn: 'border-warn-line bg-warn-soft text-warn-text',
        destructive: 'border-danger-line bg-danger-soft text-danger-text',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export type BadgeProps = React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>;

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/** Pastille d'identifiant technique : port, image, slug, hachage. */
function CodeBadge({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="code-badge"
      className={cn(
        'inline-flex w-fit items-center rounded-sm border border-border bg-surface-2 px-1.5 py-0.5',
        'font-mono text-[0.6875rem] leading-4 text-text-2',
        className,
      )}
      {...props}
    />
  );
}

export { Badge, CodeBadge, badgeVariants };
