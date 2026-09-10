import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Commande. Le style par défaut porte l'accent « signal » — un seul endroit où
 * la couleur d'accent est dépensée sur une surface pleine, pour que l'action
 * principale d'un écran se repère sans lire.
 *
 * `active:translate-y-px` : un contrôle d'exploitation doit s'enfoncer quand on
 * l'actionne. C'est le seul mouvement du composant.
 */
const buttonVariants = cva(
  [
    'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md',
    'text-sm font-medium select-none',
    'transition-[background-color,border-color,color,box-shadow,transform] duration-100 ease-out',
    'active:translate-y-px',
    'disabled:pointer-events-none disabled:opacity-45',
    'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        default: 'bg-signal text-signal-ink shadow-panel hover:bg-signal-hover',
        destructive: 'bg-danger text-white shadow-panel hover:brightness-110',
        outline:
          'border border-line-strong bg-surface text-ink shadow-panel hover:border-signal-edge hover:bg-signal-soft/60',
        secondary: 'bg-surface-2 text-ink hover:bg-surface-3',
        ghost: 'text-ink-muted hover:bg-surface-2 hover:text-ink',
        link: 'text-signal underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 has-[>svg]:px-3.5',
        sm: 'h-8 gap-1.5 px-3 text-[0.8125rem] has-[>svg]:px-2.5',
        lg: 'h-10 px-6 has-[>svg]:px-5',
        icon: 'size-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export type ButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    /** Applique le style du bouton à l'enfant direct (typiquement un `<Link>`). */
    asChild?: boolean;
  };

function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size, className }));

  if (asChild) {
    const child = React.Children.only(props.children) as React.ReactElement<{
      className?: string;
    }>;
    return React.cloneElement(child, {
      className: cn(classes, child.props.className),
    });
  }

  return <button data-slot="button" className={classes} {...props} />;
}

export { Button, buttonVariants };
