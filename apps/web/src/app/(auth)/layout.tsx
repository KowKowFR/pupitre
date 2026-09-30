import Link from 'next/link';
import type { ReactNode } from 'react';
import { getT } from '@/i18n/server';
import { auth as messages } from '@/i18n/messages/auth';
import { BrandMark } from '@/components/brand-mark';

/**
 * Écran d'entrée. Fond quadrillé très faible — un plan de baie plutôt qu'un
 * dégradé —, marque au-dessus du panneau, mention d'instance en dessous.
 * Le quadrillage est purement décoratif et masqué aux technologies d'assistance.
 */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const t = await getT(messages);

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-6 py-12">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.55]"
        style={{
          backgroundImage:
            'linear-gradient(to right, var(--border) 1px, transparent 1px), linear-gradient(to bottom, var(--border) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
          maskImage: 'radial-gradient(ellipse 70% 60% at 50% 40%, black, transparent 100%)',
          WebkitMaskImage: 'radial-gradient(ellipse 70% 60% at 50% 40%, black, transparent 100%)',
        }}
      />

      <div className="relative flex w-full max-w-sm flex-col gap-6">
        <Link href="/" className="flex items-center gap-2.5 self-center">
          <BrandMark size={32} />
          <span className="flex flex-col leading-none">
            <span className="text-base font-semibold tracking-[0.01em] text-text">Pupitre</span>
            <span className="eyebrow pt-1 text-text-3">{t('shell.tagline')}</span>
          </span>
        </Link>

        {children}

        <p className="text-center text-[0.6875rem] leading-relaxed text-text-3">
          {t('shell.footer.line1')}
          <br className="hidden sm:inline" /> {t('shell.footer.line2')}
        </p>
      </div>
    </div>
  );
}
