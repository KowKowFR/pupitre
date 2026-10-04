import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * A command. A single primary action per zone — page header, card, drawer
 * footer, dialog: it is the one that spends the full ultramarine.
 *
 * The destructive one is **outlined** (red text, pale red border): it is placed
 * apart, last. The full red, `destructive-solid`, is reserved for the final
 * confirmation of a destruction, in its dialog.
 *
 * `outline` stays accepted for the shadcn API: it is `secondary`.
 */
const buttonVariants = cva('btn', {
  variants: {
    variant: {
      default: 'btn-primary',
      secondary: 'btn-secondary',
      outline: 'btn-secondary',
      ghost: 'btn-ghost',
      destructive: 'btn-danger',
      'destructive-solid': 'btn-danger-solid',
      link: 'btn-link',
    },
    size: {
      default: '',
      sm: 'btn-sm',
      lg: 'btn-lg',
      icon: 'btn-icon',
      'icon-sm': 'btn-icon btn-sm',
    },
  },
  defaultVariants: {
    variant: 'default',
    size: 'default',
  },
});

export type ButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    /** Applies the button's style to the direct child (typically a `<Link>`). */
    asChild?: boolean;
    /**
     * Work in progress: spinner, inert button. The label passed as a child must
     * already carry its "…" ("Deploying…") — it is a sentence, not a suffix to stick
     * on.
     */
    loading?: boolean;
    /**
     * Why this button is disabled, spelled out. Providing it **disables** the button
     * and shows the reason under it, as a caption: a greyed out button without a
     * visible explanation is forbidden by the system, and a tooltip alone is not
     * enough.
     */
    disabledReason?: React.ReactNode;
  };

function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  disabledReason,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const reasonId = React.useId();
  const classes = cn(buttonVariants({ variant, size }), className);
  const blocked = Boolean(disabled) || loading || Boolean(disabledReason);

  if (asChild) {
    // Everything goes to the child — accessible label, a tooltip's handlers, `ref` —
    // and not the class alone.
    const child = React.Children.only(children) as React.ReactElement<{
      className?: string;
    }>;
    return React.cloneElement(child, {
      ...props,
      className: cn(classes, child.props.className),
    });
  }

  const button = (
    <button
      data-slot="button"
      className={classes}
      disabled={blocked}
      aria-busy={loading || undefined}
      aria-describedby={disabledReason ? reasonId : undefined}
      {...props}
    >
      {loading ? <span className="spin" aria-hidden /> : null}
      {children}
    </button>
  );

  if (!disabledReason) return button;

  return (
    <span data-slot="button-with-reason" className="inline-flex flex-col items-start gap-1.5">
      {button}
      <span id={reasonId} className="reason">
        {disabledReason}
      </span>
    </span>
  );
}

/**
 * A row of actions disabled for the same reason: the reason is said once, under
 * the row, as on the "Disabled with a reason" board.
 */
function ActionRow({
  reason,
  className,
  children,
}: {
  reason?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      {reason ? <span className="reason">{reason}</span> : null}
    </div>
  );
}

export { Button, ActionRow, buttonVariants };
