import { cn } from '@/lib/utils';

/**
 * Gabarit d'attente, à la silhouette exacte de ce qu'il remplace. Un reflet
 * lent le traverse ; il disparaît sous `prefers-reduced-motion`, le gabarit
 * reste.
 */
export function Skeleton({
  className,
  variant = 'block',
}: {
  className?: string;
  variant?: 'block' | 'text' | 'circle';
}) {
  return (
    <div
      aria-hidden
      className={cn('sk', variant === 'text' && 'sk-t', variant === 'circle' && 'sk-circle', className)}
    />
  );
}
