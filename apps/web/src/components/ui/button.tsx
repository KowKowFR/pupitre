import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Commande. Une seule action primaire par zone — en-tête de page, carte, pied
 * de drawer, dialogue : c'est elle qui dépense l'outremer plein.
 *
 * Le destructif est **au trait** (texte rouge, liseré rouge pâle) : on le
 * place à part, en dernier. Le rouge plein, `destructive-solid`, est réservé
 * à la confirmation finale d'une destruction, dans son dialogue.
 *
 * `outline` reste accepté pour l'API shadcn : c'est `secondary`.
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
    /** Applique le style du bouton à l'enfant direct (typiquement un `<Link>`). */
    asChild?: boolean;
    /**
     * Travail en cours : spinner, bouton inerte. Le libellé passé en enfant
     * doit déjà porter son « … » (« Déploiement… ») — c'est une phrase, pas
     * un suffixe à coller.
     */
    loading?: boolean;
    /**
     * Pourquoi ce bouton est désactivé, en clair. Le fournir **désactive** le
     * bouton et affiche la raison sous lui, en légende : un bouton grisé sans
     * explication visible est interdit par le système, et une info-bulle
     * seule ne suffit pas.
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
    const child = React.Children.only(children) as React.ReactElement<{
      className?: string;
    }>;
    return React.cloneElement(child, {
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
 * Une rangée d'actions désactivées pour une même raison : la raison se dit
 * une fois, sous la rangée, comme sur la planche « Désactivé avec raison ».
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
