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
        default: 'border-signal-edge bg-signal-soft text-signal',
        secondary: 'border-line bg-surface-2 text-ink-muted',
        outline: 'border-line-strong bg-transparent text-ink-muted',
        solid: 'border-transparent bg-signal text-signal-ink',
        ok: 'border-ok-edge bg-ok-soft text-ok',
        warn: 'border-warn-edge bg-warn-soft text-warn',
        destructive: 'border-danger-edge bg-danger-soft text-danger',
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
        'inline-flex w-fit items-center rounded-sm border border-line bg-surface-2 px-1.5 py-0.5',
        'font-mono text-[0.6875rem] leading-4 text-ink-muted',
        className,
      )}
      {...props}
    />
  );
}

export { Badge, CodeBadge, badgeVariants };
