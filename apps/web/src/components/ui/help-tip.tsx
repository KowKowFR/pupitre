'use client';

import type * as React from 'react';
import { Info } from 'lucide-react';
import { useT } from '@/i18n/client';
import { chrome } from '@/i18n/messages/chrome';
import { cn } from '@/lib/utils';
import { Tooltip } from './tooltip';

/**
 * A help folded into a tooltip: a small icon next to a label, the explanation on
 * hover as on focus. For dense screens, where each field carried two lines of
 * prose one only reads once.
 *
 * A button, to be reached with the keyboard; placed in a `<label>`, it neither
 * checks nor focuses anything — a click on an interactive element does not
 * activate the label containing it.
 */
export function HelpTip({
  children,
  label,
  className,
}: {
  children: React.ReactNode;
  /** The button's accessible name; "Help" by default. */
  label?: string;
  className?: string;
}) {
  const t = useT(chrome);
  return (
    <Tooltip content={children} wide>
      <button
        type="button"
        className={cn('help-tip', className)}
        aria-label={label ?? t('help.more')}
        onClick={(event) => event.preventDefault()}
      >
        <Info aria-hidden />
      </button>
    </Tooltip>
  );
}
