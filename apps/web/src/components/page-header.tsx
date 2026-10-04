import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The page header. The title in 24/32, slightly condensed; a description of 68
 * characters at most per line; the actions on the right, at the title's height.
 * No more overline: the top bar's breadcrumb places the page.
 *
 * `status` sits next to the title (a target's, a probe's state); `children`
 * hosts what follows the description (meta, labels).
 */
export function PageHeader({
  title,
  description,
  actions,
  status,
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  status?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cn('ph', className)}>
      <div className="ph-t">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="t-page min-w-0 break-words">{title}</h1>
          {status}
        </div>
        {description ? <p className="ph-d">{description}</p> : null}
        {children}
      </div>
      {actions ? <div className="ph-a">{actions}</div> : null}
    </div>
  );
}
