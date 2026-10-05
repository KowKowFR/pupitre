'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A checkbox — 16 px, white check on ultramarine, mixed state included.
 *
 * The native one already carries the keyboard, the role and the `indeterminate`
 * state; only the appearance is missing. `indeterminate` only exists as a DOM
 * property, never as an attribute: hence the `ref` that sets it again at each
 * change.
 */
export type CheckboxProps = Omit<React.ComponentProps<'input'>, 'type'> & {
  indeterminate?: boolean;
};

function Checkbox({ className, indeterminate = false, ref, ...props }: CheckboxProps) {
  const inner = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (inner.current) inner.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      type="checkbox"
      data-slot="checkbox"
      ref={(node) => {
        inner.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      }}
      aria-checked={indeterminate ? 'mixed' : undefined}
      className={cn('cb', className)}
      {...props}
    />
  );
}

/**
 * A checkbox and its label, with an optional help underneath — the shape of the
 * permission lists and form options.
 */
function CheckboxField({
  label,
  help,
  className,
  ...props
}: CheckboxProps & { label: React.ReactNode; help?: React.ReactNode }) {
  return (
    <label className={cn('check', className)}>
      <Checkbox {...props} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="t-sm font-medium">{label}</span>
        {help ? <span className="help">{help}</span> : null}
      </span>
    </label>
  );
}

/**
 * A checkbox shown as a chip — the seven days of the week, typically, where a
 * column of checkboxes would take the whole width. The native one carries the
 * state, `has-[:checked]` carries the style.
 */
export type CheckboxChipProps = Omit<React.ComponentProps<'input'>, 'type'> & {
  label: React.ReactNode;
};

function CheckboxChip({ className, label, ...props }: CheckboxChipProps) {
  return (
    <label
      className={cn(
        'chip justify-center min-w-9 select-none',
        'has-[:checked]:border-accent-line has-[:checked]:bg-accent-soft has-[:checked]:text-accent-text',
        'has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50',
        'has-[:focus-visible]:shadow-focus',
        className,
      )}
    >
      <input type="checkbox" className="sr-only" {...props} />
      {label}
    </label>
  );
}

export { Checkbox, CheckboxField, CheckboxChip };
