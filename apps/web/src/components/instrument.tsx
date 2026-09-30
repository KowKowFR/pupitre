import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type Tone = 'ok' | 'warn' | 'danger' | 'signal' | 'idle';

const DOT: Record<Tone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  signal: 'bg-accent',
  idle: 'bg-text-3/60',
};

const HALO: Record<Tone, string> = {
  ok: 'bg-ok/25',
  warn: 'bg-warn/25',
  danger: 'bg-danger/25',
  signal: 'bg-accent/25',
  idle: 'bg-transparent',
};

/**
 * Voyant. Un point plein cerclé d'un halo de la même teinte — la lecture tient
 * à la couleur *et* à la présence du halo, donc elle survit au daltonisme et
 * aux captures en niveaux de gris.
 *
 * `pulse` n'anime que ce qui est réellement en mouvement, et se fige sous
 * `prefers-reduced-motion`.
 */
export function Led({
  tone,
  pulse = false,
  className,
}: {
  tone: Tone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span className={cn('relative flex size-2.5 shrink-0 items-center justify-center', className)}>
      <span
        aria-hidden
        className={cn(
          'absolute inset-0 rounded-full',
          HALO[tone],
          pulse && 'animate-soft-pulse',
        )}
      />
      <span aria-hidden className={cn('relative size-1.5 rounded-full', DOT[tone])} />
    </span>
  );
}

/**
 * Relevé chiffré. Le nombre est en chasse fixe et en chiffres tabulaires : deux
 * relevés côte à côte s'alignent, même quand l'un passe de 9 à 10.
 */
export function Readout({
  label,
  value,
  unit,
  tone = 'idle',
  pulse = false,
  hint,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  tone?: Tone;
  pulse?: boolean;
  hint?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 px-4 py-3.5 first:pl-5 last:pr-5">
      <div className="flex items-center gap-1.5">
        <Led tone={tone} pulse={pulse} />
        <span className="eyebrow truncate text-text-3">{label}</span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[1.375rem] leading-none font-medium text-text tabular-nums">
          {value}
        </span>
        {unit ? <span className="font-mono text-xs text-text-3">{unit}</span> : null}
      </div>
      {hint ? <span className="truncate text-[0.6875rem] text-text-3">{hint}</span> : null}
    </div>
  );
}

/**
 * Bandeau de relevés : une rangée d'instruments séparés par des filets, comme
 * la face avant d'un équipement. Passe en grille sur écran étroit.
 */
export function ReadoutBar({ children }: { children: ReactNode }) {
  return (
    /*
      Requête de conteneur et non de fenêtre : ce qui décide du nombre de
      colonnes, c'est la largeur disponible pour la barre, pas celle de
      l'écran. À 1024 px de fenêtre, le rail de navigation en prend 246 et
      quatre colonnes tronquaient « Applications en marche » en
      « Applications en m… ». Mesurer la fenêtre aurait fait dépendre le bon
      seuil de la largeur du rail — un couplage qui casse à la première
      retouche de la navigation.
    */
    <div className="@container">
      <div className="grid grid-cols-2 divide-x divide-y divide-border rounded-lg border border-border bg-card shadow-xs @3xl:grid-cols-4 @3xl:divide-y-0">
        {children}
      </div>
    </div>
  );
}
