import Link from 'next/link';
import type { ReactNode } from 'react';
import { getT } from '@/i18n/server';
import { auth as messages } from '@/i18n/messages/auth';
import { BrandMark, Wordmark } from '@/components/brand-mark';

/**
 * Écran d'entrée. Fond quadrillé très faible — un plan de baie plutôt qu'un
 * dégradé —, marque au-dessus du panneau, mention d'instance en dessous.
 * Le quadrillage est purement décoratif et masqué aux technologies d'assistance.
 */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const t = await getT(messages);

  return (
    <div
      className="relative flex min-h-dvh flex-col items-center overflow-hidden bg-bg px-6 pt-[72px] pb-10"
      style={{
        backgroundImage:
          'linear-gradient(var(--border-subtle) 1px, transparent 1px), linear-gradient(90deg, var(--border-subtle) 1px, transparent 1px)',
        backgroundSize: '48px 48px',
      }}
    >
      {/* La grille s'estompe en ellipse autour de la carte : un décor, pas un motif. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: 'radial-gradient(ellipse 60% 55% at 50% 42%, transparent 0, var(--bg) 78%)',
        }}
      />

      <main className="relative flex w-full max-w-[400px] flex-col gap-6">
        <Link
          href="/"
          className="flex flex-col items-center gap-2.5 self-center rounded-lg outline-none focus-visible:shadow-focus"
        >
          <BrandMark size={40} />
          <span className="flex flex-col items-center">
            <Wordmark size={26} />
            <span className="t-cap mt-1.5 text-text-3">{t('shell.tagline')}</span>
          </span>
        </Link>

        {children}

        <p className="t-cap mx-auto max-w-[340px] text-center text-text-3">
          {t('shell.footer.line1')} {t('shell.footer.line2')}
        </p>
      </main>
    </div>
  );
}
