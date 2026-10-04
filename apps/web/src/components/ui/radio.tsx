'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * An exclusive choice shown as segments — the kit's segmented control, written on
 * top of a native `<input type="radio">`: the browser provides the semantics and
 * the arrow navigation, `:has(:checked)` carries the style. A selected segment is
 * not React state, it is the field's state.
 */
function RadioGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div role="radiogroup" data-slot="radio-group" className={cn('seg', className)} {...props} />
  );
}

export type RadioOptionProps = Omit<React.ComponentProps<'input'>, 'type'> & {
  label: React.ReactNode;
};

function RadioOption({ className, label, ...props }: RadioOptionProps) {
  return (
    <label className={className}>
      <input type="radio" className="sr-only" {...props} />
      {label}
    </label>
  );
}

/** A classic radio button, with its label and an optional help. */
function Radio({
  label,
  help,
  className,
  ...props
}: Omit<React.ComponentProps<'input'>, 'type'> & {
  label: React.ReactNode;
  help?: React.ReactNode;
}) {
  return (
    <label className={cn('check', className)}>
      <input type="radio" className="rd" {...props} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="t-sm font-medium">{label}</span>
        {help ? <span className="help">{help}</span> : null}
      </span>
    </label>
  );
}

export { RadioGroup, RadioOption, Radio };
