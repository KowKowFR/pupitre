import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A box — a tone icon, a text, an optional action on the right. The tone reads
 * from the icon as much as from the color. A danger box is announced
 * (`role="alert"`), the others are states (`role="status"`).
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
    /** A bold title, at the top of the text. */
    title?: React.ReactNode;
    /** An action on the right (a button, a link). */
    action?: React.ReactNode;
    /** `false` for a box without an icon. */
    icon?: boolean;
  };

function Alert({ className, variant, title, action, icon = true, children, ...props }: AlertProps) {
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
