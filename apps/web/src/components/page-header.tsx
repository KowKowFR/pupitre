import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Bandeau de page. Le surtitre condensé situe la section, le titre nomme
 * l'objet, la ligne de dessous dit ce qu'on peut en faire. Les actions restent
 * à droite, à hauteur du titre : c'est là qu'on les cherche.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-line pb-5',
        className,
      )}
    >
      <div className="min-w-0 space-y-1.5">
        {eyebrow ? <div className="eyebrow text-ink-faint">{eyebrow}</div> : null}
        <h1 className="font-condensed text-[1.625rem] leading-none font-semibold tracking-[-0.005em] text-ink">
          {title}
        </h1>
        {description ? (
          <p className="max-w-[62ch] text-[0.8125rem] leading-relaxed text-ink-muted">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
