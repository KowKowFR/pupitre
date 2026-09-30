import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * En-tête de page. Le titre en 24/32, légèrement condensé ; une description
 * de 68 caractères au plus par ligne ; les actions à droite, à hauteur du
 * titre. Plus de surtitre : le fil d'Ariane de la barre haute situe la page.
 *
 * `status` se pose à côté du titre (l'état d'une cible, d'une sonde) ;
 * `children` accueille ce qui suit la description (méta, étiquettes).
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
