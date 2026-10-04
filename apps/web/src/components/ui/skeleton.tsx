import { cn } from '@/lib/utils';

/**
 * A waiting template, with the exact silhouette of what it replaces. A slow
 * shimmer crosses it; it disappears under `prefers-reduced-motion`, the template
 * stays.
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
      className={cn(
        'sk',
        variant === 'text' && 'sk-t',
        variant === 'circle' && 'sk-circle',
        className,
      )}
    />
  );
}
