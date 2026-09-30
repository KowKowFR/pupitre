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
        <span className="text-[14px] font-semibold text-text">{instanceName}</span>
        <span className="t-sm text-text-3">{eyebrow}</span>
        <span className="ml-auto flex items-center gap-3">{children}</span>
      </div>
    </header>
  );
}
