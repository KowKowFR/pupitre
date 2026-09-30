import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';

/**
 * Écran vide. Il dit ce qui manque et par où commencer — jamais « aucune
 * donnée » tout court.
 */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card className="items-center gap-3 border-dashed py-12 text-center">
      <div className="space-y-1.5 px-6">
        <p className="text-base font-semibold text-text">{title}</p>
        {hint ? (
          <p className="mx-auto max-w-[48ch] text-[0.8125rem] leading-relaxed text-text-2">
            {hint}
          </p>
        ) : null}
      </div>
      {action}
    </Card>
  );
}
