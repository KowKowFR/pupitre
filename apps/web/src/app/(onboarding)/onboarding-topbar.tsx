import type { ReactNode } from 'react';
import { BrandMark } from '@/components/brand-mark';

/**
 * The assistant's thin header: the brand, the instance's name, "Getting started"
 * — and, on the right, what the current step puts there (the progress,
 * "Later"). No rail: the journey is linear, so is the screen.
 */
export function OnboardingTopbar({
  instanceName,
  eyebrow,
  children,
}: {
  instanceName: string;
  eyebrow: string;
  children?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-border-subtle bg-surface">
      <div className="flex h-14 items-center gap-2.5 px-6">
        <BrandMark size={26} />
        <span className="min-w-0 truncate text-[14px] font-semibold text-text">{instanceName}</span>
        {/* On a phone, the brand and the name are enough: the room goes to the actions. */}
        <span className="t-sm hidden shrink-0 text-text-3 sm:inline">{eyebrow}</span>
        <span className="ml-auto flex shrink-0 items-center gap-3">{children}</span>
      </div>
    </header>
  );
}
