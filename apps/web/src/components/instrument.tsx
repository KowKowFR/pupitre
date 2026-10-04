import type { ReactNode } from 'react';
import { Led, type Tone } from '@/components/ui/led';
import { cn } from '@/lib/utils';

export { Led, type Tone };

/**
 * A numeric readout. The label is in sentence case, preceded by its indicator;
 * the number is in tabular figures, followed by its unit in gray: two readouts
 * side by side line up, even when one goes from 9 to 10.
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
  /** A meta to the right of the label: the trend ("stable", "+6 pt"). */
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
 * A readings band: four columns separated by rules. A container query and not a
 * viewport one: it is the width available to the band that decides the switch to
 * two columns, not the screen's.
 *
 * `bare` sets it without a card, to insert it into an existing card.
 */
export function ReadoutBar({
  children,
  bare = false,
  compact = false,
  className,
}: {
  children: ReactNode;
  bare?: boolean;
  /** Tighter cells and smaller figures, for a band housed in a card. */
  compact?: boolean;
  className?: string;
}) {
  const bar = (
    <div className="@container">
      <div className={cn('readouts', compact && 'is-compact')}>{children}</div>
    </div>
  );
  if (bare) return <div className={className}>{bar}</div>;
  return <section className={cn('card', className)}>{bar}</section>;
}
