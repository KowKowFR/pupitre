import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type Tone = 'ok' | 'warn' | 'danger' | 'accent' | 'idle' | 'hollow';

/**
 * An indicator — 8 px, ringed with a 3 px halo of the same tint at 20%.
 *
 * An indicator is never read alone: it has a label next to it (`State`), or, in
 * a very dense list, a `label` that makes it a named image for screen readers.
 * `pulse` is reserved for what is **in progress**; it freezes under
 * `prefers-reduced-motion`.
 */
export function Led({
  tone,
  pulse = false,
  label,
  className,
}: {
  tone: Tone;
  pulse?: boolean;
  /** Accessible name, when no visible text goes with the indicator. */
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

/** An indicator and its label, with an optional meta in gray. */
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
