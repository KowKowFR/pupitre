'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A switch — 32 × 18, the knob slides on the entrance curve. A native checkbox
 * with `role="switch"`: the state reads "on / off" to screen readers, and the
 * keyboard is the system's.
 */
function Switch({ className, ...props }: Omit<React.ComponentProps<'input'>, 'type' | 'role'>) {
  return (
    <input
      type="checkbox"
      role="switch"
      data-slot="switch"
      className={cn('sw', className)}
      {...props}
    />
  );
}

/** A switch and its label, with a help underneath. */
function SwitchField({
  label,
  help,
  className,
  ...props
}: Omit<React.ComponentProps<'input'>, 'type' | 'role'> & {
  label: React.ReactNode;
  help?: React.ReactNode;
}) {
  return (
    <label className={cn('check', className)}>
      <Switch {...props} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="t-sm font-medium">{label}</span>
        {help ? <span className="help">{help}</span> : null}
      </span>
    </label>
  );
}

export { Switch, SwitchField };
