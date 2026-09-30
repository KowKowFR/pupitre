import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type Tone = 'ok' | 'warn' | 'danger' | 'accent' | 'idle' | 'hollow';

/**
 * Voyant — 8 px, cerclé d'un halo de 3 px de la même teinte à 20 %.
 *
 * Un voyant ne se lit jamais seul : il a un libellé à côté (`State`), ou, dans
 * une liste très dense, un `label` qui en fait une image nommée pour les
 * lecteurs d'écran. `pulse` est réservé à ce qui est **en cours** ; il se fige
 * sous `prefers-reduced-motion`.
 */
export function Led({
  tone,
  pulse = false,
  label,
  className,
}: {
  tone: Tone;
  pulse?: boolean;
  /** Nom accessible, quand aucun texte visible n'accompagne le voyant. */
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={cn('led', tone !== 'idle' && `led-${tone}`, pulse && 'led-pulse', className)}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    />
  );
}

/** Voyant et son libellé, avec une méta facultative en gris. */
export function State({
  tone,
  pulse,
  children,
  meta,
  className,
}: {
  tone: Tone;
  pulse?: boolean;
  children: ReactNode;
  meta?: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn('state', className)}>
      <Led tone={tone} pulse={pulse} />
      <span className="font-medium">{children}</span>
      {meta ? <span className="text-text-3">{meta}</span> : null}
    </span>
  );
}
