'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { useT } from '@/i18n/client';
import { chrome } from '@/i18n/messages/chrome';

/**
 * Waiting for a panel screen: the silhouette of most pages — a header with its
 * actions, a readings band, a list. It holds the place of what is coming, so that
 * the screen does not rearrange itself before one's eyes.
 *
 * A client component for its `aria-label` alone: a `loading.tsx` is a
 * `Suspense`'s fallback, and a fallback cannot suspend — so it cannot be `async`,
 * so it cannot call `getT()`.
 */
export default function AppLoading() {
  const t = useT(chrome);

  return (
    <div className="contents" aria-busy="true" aria-label={t('shell.loading')}>
      <div className="ph">
        <div className="ph-t">
          <Skeleton className="h-[22px] w-[220px]" />
          <Skeleton className="sk-t w-[520px] max-w-full" />
        </div>
        <div className="ph-a">
          <Skeleton className="h-8 w-[90px] rounded-lg" />
          <Skeleton className="h-8 w-[110px] rounded-lg" />
        </div>
      </div>

      <section className="card @container">
        <div className="readouts">
          {[0, 1, 2, 3].map((slot) => (
            <div key={slot} className="readout">
              <Skeleton className="sk-t w-[110px]" />
              <Skeleton className="h-6 w-[70px]" />
              <Skeleton className="sk-t w-[150px]" />
            </div>
          ))}
        </div>
      </section>

      <section className="card overflow-hidden">
        <div className="card-h">
          <Skeleton className="sk-t w-[140px]" />
        </div>
        <ul className="list">
          {[0, 1, 2, 3, 4].map((slot) => (
            <li key={slot} className="gap-4">
              <Skeleton className="size-2 rounded-full" />
              <span className="flex w-[200px] flex-col gap-1.5">
                <Skeleton className="sk-t w-[120px]" />
                <Skeleton className="sk-t w-[80px]" />
              </span>
              <Skeleton className="h-5 w-[240px] max-sm:hidden" />
              <span className="ml-auto flex gap-3">
                <Skeleton className="sk-t w-[60px]" />
                <Skeleton className="sk-t w-[60px]" />
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
