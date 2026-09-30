import type { ReactNode } from 'react';
import { Led, type Tone } from '@/components/ui/led';
import { cn } from '@/lib/utils';

export { Led, type Tone };

/**
 * Relevé chiffré. L'étiquette est en casse de phrase, précédée de son voyant ;
 * le nombre est en chiffres tabulaires, suivi de son unité en gris : deux
 * relevés côte à côte s'alignent, même quand l'un passe de 9 à 10.
 */
export function Readout({
  label,
  value,
  unit,
  tone = 'idle',
  pulse = false,
  hint,
  aside,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  tone?: Tone;
  pulse?: boolean;
  hint?: ReactNode;
  /** Une méta à droite de l'étiquette : la tendance (« stable », « +6 pt »). */
  aside?: ReactNode;
}) {
  return (
    <div className="readout">
      <span className="lbl">
        <Led tone={tone} pulse={pulse} />
        <span className="truncate">{label}</span>
        {aside ? (
          <span className="t-cap ml-auto shrink-0 font-normal text-text-3">{aside}</span>
        ) : null}
      </span>
      <span>
        <span className="t-stat">{value}</span>
        {unit ? <span className="t-unit">{unit}</span> : null}
      </span>
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

/**
 * Bande de relevés : quatre colonnes séparées par des filets. Requête de
 * conteneur et non de fenêtre : c'est la largeur disponible pour la bande qui
 * décide du passage à deux colonnes, pas celle de l'écran.
 *
 * `bare` la pose sans carte, pour l'insérer dans une carte existante.
 */
export function ReadoutBar({
  children,
  bare = false,
  className,
}: {
  children: ReactNode;
  bare?: boolean;
  className?: string;
}) {
  const bar = (
    <div className="@container">
      <div className="readouts">{children}</div>
    </div>
  );
  if (bare) return <div className={className}>{bar}</div>;
  return <section className={cn('card', className)}>{bar}</section>;
}
