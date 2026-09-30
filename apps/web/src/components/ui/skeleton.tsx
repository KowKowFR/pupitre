import { cn } from '@/lib/utils';

/**
 * Gabarit d'attente. Un balayage lent plutôt qu'un clignotement : on doit
 * pouvoir le regarder plusieurs secondes sans fatigue, et il s'immobilise sous
 * `prefers-reduced-motion`.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        'animate-sweep rounded-sm bg-surface-2',
        'bg-[linear-gradient(90deg,var(--surface-2)_0%,var(--surface-3)_50%,var(--surface-2)_100%)]',
        className,
      )}
    />
  );
}
