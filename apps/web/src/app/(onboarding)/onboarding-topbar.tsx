import type { ReactNode } from 'react';
import { BrandMark } from '@/components/brand-mark';

/**
 * L'en-tête mince de l'assistant : la marque, le nom de l'instance, « Premiers
 * pas » — et, à droite, ce que l'étape en cours y pose (l'avancement, « Plus
 * tard »). Pas de rail : le parcours est linéaire, l'écran l'est aussi.
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
        {/* Sur un téléphone, la marque et le nom suffisent : la place va aux actions. */}
        <span className="t-sm hidden shrink-0 text-text-3 sm:inline">{eyebrow}</span>
        <span className="ml-auto flex shrink-0 items-center gap-3">{children}</span>
      </div>
    </header>
  );
}
