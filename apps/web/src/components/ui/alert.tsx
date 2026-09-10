import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Encadré d'information. Le liseré gauche épais porte la sémantique : on sait
 * de quoi il s'agit avant d'avoir lu la première ligne.
 */
const alertVariants = cva(
  'rounded-md border border-l-[3px] px-3.5 py-2.5 text-[0.8125rem] leading-relaxed',
  {
    variants: {
      variant: {
        default: 'border-line border-l-line-strong bg-surface-2 text-ink',
        info: 'border-signal-edge border-l-signal bg-signal-soft/50 text-ink',
        destructive: 'border-danger-edge border-l-danger bg-danger-soft/60 text-ink',
        warn: 'border-warn-edge border-l-warn bg-warn-soft/60 text-ink',
        success: 'border-ok-edge border-l-ok bg-ok-soft/60 text-ink',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export type AlertProps = React.ComponentProps<'div'> & VariantProps<typeof alertVariants>;

function Alert({ className, variant, ...props }: AlertProps) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Alert, alertVariants };
