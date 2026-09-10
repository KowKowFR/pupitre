import { Skeleton } from '@/components/ui/skeleton';

/**
 * Attente du suivi de déploiement : la silhouette annonce déjà les deux
 * colonnes, pour que l'écran ne se réorganise pas sous les yeux au moment où
 * les données arrivent.
 */
export default function DeploymentLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Chargement du déploiement">
      <div className="flex flex-col gap-2.5 border-b border-line pb-5">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-3.5 w-96 max-w-full" />
      </div>

      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-line bg-card px-5 py-4">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-8 w-32" />
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,21rem)_minmax(0,1fr)]">
        <div className="flex h-fit flex-col gap-3 rounded-lg border border-line bg-card p-5">
          {[0, 1, 2, 3, 4, 5, 6].map((slot) => (
            <div key={slot} className="flex items-center gap-3">
              <Skeleton className="size-[1.125rem] rounded-full" />
              <Skeleton className="h-3.5 flex-1" />
            </div>
          ))}
        </div>
        <div className="h-[30rem] rounded-lg border border-line bg-terminal" />
      </div>
    </div>
  );
}
