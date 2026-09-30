'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { useT } from '@/i18n/client';
import { deployments as messages } from '@/i18n/messages/deployments';

/**
 * Attente du suivi de déploiement : la silhouette annonce déjà les deux
 * colonnes, pour que l'écran ne se réorganise pas sous les yeux au moment où
 * les données arrivent.
 *
 * Composant client, pour son seul `aria-label` : un `loading.tsx` est le
 * fallback d'un `Suspense`, et un fallback ne peut pas suspendre — il ne peut
 * donc pas être `async`, donc pas appeler `getT()`.
 */
export default function DeploymentLoading() {
  const t = useT(messages);

  return (
    <div className="contents" aria-busy="true" aria-label={t('loading.label')}>
      <div className="ph">
        <div className="ph-t">
          <Skeleton className="h-7 w-72" />
          <Skeleton className="sk-t w-96 max-w-full" />
        </div>
      </div>

      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-6 px-[18px] py-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-20" />
            <Skeleton className="sk-t w-36" />
          </div>
          {[0, 1, 2].map((slot) => (
            <div key={slot} className="flex flex-col gap-2">
              <Skeleton className="sk-t w-14" />
              <Skeleton className="sk-t w-24" />
            </div>
          ))}
        </div>
        <div className="h-[3px] bg-surface-3" />
      </section>

      <div className="tabs">
        <Skeleton className="my-2.5 h-4 w-16" />
        <Skeleton className="my-2.5 h-4 w-16" />
        <Skeleton className="my-2.5 h-4 w-24" />
      </div>

      <div className="grid items-stretch gap-5 lg:grid-cols-[336px_minmax(0,1fr)]">
        <section className="card">
          <div className="card-h">
            <Skeleton className="sk-t w-20" />
            <Skeleton className="sk-t ml-auto w-24" />
          </div>
          <div className="card-b flex flex-col gap-4">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((slot) => (
              <div key={slot} className="flex items-center gap-3">
                <Skeleton className="size-[22px] rounded-full" />
                <Skeleton className="sk-t flex-1" />
                <Skeleton className="sk-t w-14" />
              </div>
            ))}
          </div>
        </section>
        <div className="term min-h-[30rem]" />
      </div>
    </div>
  );
}
