import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Encadré — une icône de ton, un texte, une action facultative à droite. Le
 * ton se lit à l'icône autant qu'à la couleur. Un encadré de danger est
 * annoncé (`role="alert"`), les autres sont des états (`role="status"`).
 */
const alertVariants = cva('alert', {
  variants: {
    variant: {
      default: '',
      info: 'alert-info',
      success: 'alert-ok',
      warn: 'alert-warn',
      destructive: 'alert-danger',
    },
  },
  defaultVariants: { variant: 'default' },
});

type Variant = NonNullable<VariantProps<typeof alertVariants>['variant']>;

const ICON: Record<Variant, React.ComponentType<{ 'aria-hidden'?: boolean }>> = {
  default: Info,
  info: Info,
  success: CircleCheck,
  warn: TriangleAlert,
  destructive: CircleAlert,
};

export type AlertProps = React.ComponentProps<'div'> &
  VariantProps<typeof alertVariants> & {
    /** Titre en gras, en tête du texte. */
    title?: React.ReactNode;
    /** Action à droite (un bouton, un lien). */
    action?: React.ReactNode;
    /** `false` pour un encadré sans icône. */
    icon?: boolean;
  };

function Alert({
  className,
  variant,
  title,
  action,
  icon = true,
  children,
  ...props
}: AlertProps) {
  const tone: Variant = variant ?? 'default';
  const Icon = ICON[tone];
  return (
    <div
      data-slot="alert"
      role={tone === 'destructive' ? 'alert' : 'status'}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    >
      {icon ? <Icon aria-hidden /> : null}
      <div className="min-w-0 flex-1">
        {title ? <strong>{title}</strong> : null}
        {title && children ? ' ' : null}
        {children}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

export { Alert, alertVariants };
