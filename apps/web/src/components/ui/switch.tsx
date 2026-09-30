'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Interrupteur — 32 × 18, la pastille glisse sur la courbe d'entrée. Une case
 * à cocher native avec `role="switch"` : l'état se lit « activé / désactivé »
 * aux lecteurs d'écran, et le clavier est celui du système.
 */
function Switch({ className, ...props }: Omit<React.ComponentProps<'input'>, 'type' | 'role'>) {
  return <input type="checkbox" role="switch" data-slot="switch" className={cn('sw', className)} {...props} />;
}

/** Interrupteur et son libellé, avec une aide dessous. */
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
