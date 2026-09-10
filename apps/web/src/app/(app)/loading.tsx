import { Skeleton } from '@/components/ui/skeleton';

/**
 * Gabarit d'attente commun aux pages de l'espace connecté.
 *
 * Toutes ces pages sont `force-dynamic` : elles interrogent PostgreSQL, parfois
 * Redis, avant de rendre quoi que ce soit. Sans ce fichier, la navigation reste
 * figée sur l'écran précédent — on ne sait pas si le clic a été pris. Le
 * gabarit reprend la silhouette réelle : bandeau, rangée de relevés, panneaux.
 */
export default function AppLoading() {
  return (
    <div className="flex flex-col gap-7" aria-busy="true" aria-label="Chargement">
      <div className="flex flex-col gap-2.5 border-b border-line pb-5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-3.5 w-[28rem] max-w-full" />
      </div>

      <div className="grid grid-cols-2 divide-x divide-y divide-line rounded-lg border border-line bg-card sm:grid-cols-4 sm:divide-y-0">
        {[0, 1, 2, 3].map((slot) => (
          <div key={slot} className="flex flex-col gap-2 px-4 py-3.5">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-6 w-16" />
            <Skeleton className="h-2.5 w-24" />
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-line bg-card p-5">
        {[0, 1, 2, 3, 4].map((slot) => (
          <div key={slot} className="flex items-center gap-4">
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-5 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}
