import type { ComponentType, ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * An empty screen. An icon cartouche, what is missing, where to start — never a
 * bare "no data".
 */
export function EmptyState({
  title,
  hint,
  action,
  icon: Icon = Inbox,
  className,
}: {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  icon?: ComponentType<{ 'aria-hidden'?: boolean }>;
  className?: string;
}) {
  return (
    <div className={cn('empty', className)}>
      <span className="empty-mark">
        <Icon aria-hidden />
      </span>
      <h3>{title}</h3>
      {hint ? <p>{hint}</p> : null}
      {action ? (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{action}</div>
      ) : null}
    </div>
  );
}
