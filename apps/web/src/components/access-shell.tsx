import Link from 'next/link';
import type { ReactNode } from 'react';
import { BrandMark, Wordmark } from '@/components/brand-mark';
import { cn } from '@/lib/utils';

/**
 * La coquille des écrans hors panel — accès, page introuvable, accès refusé :
 * une grille de 48 px estompée en ellipse, la tuile et le mot-symbole, une
 * colonne de 400 px. Un décor, pas un motif : il dit « vous êtes chez
 * Pupitre » sans rien demander.
 */
export function AccessShell({
  tagline,
  footer,
  children,
}: {
  tagline: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className="relative flex min-h-dvh flex-col items-center overflow-hidden bg-bg px-6 pt-[72px] pb-10"
      style={{
        backgroundImage:
          'linear-gradient(var(--border-subtle) 1px, transparent 1px), linear-gradient(90deg, var(--border-subtle) 1px, transparent 1px)',
        backgroundSize: '48px 48px',
      }}
    >
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
            <span className="t-cap mt-1.5 text-text-3">{tagline}</span>
          </span>
        </Link>

        {children}

        {footer ? (
          <p className="t-cap mx-auto max-w-[340px] text-center text-text-3">{footer}</p>
        ) : null}
      </main>
    </div>
  );
}

/**
 * La carte de ces écrans : rayon 14, ombre marquée, 28 px de marge. Un titre,
 * une phrase qui dit ce qu'on attend, puis le formulaire — ou l'état qui le
 * remplace (« envoyé », « périmé », « fait ») dans la même carte.
 *
 * `tone` borde la carte d'une couleur d'état : un refus en rouge.
 */
export function AccessCard({
  title,
  description,
  tone,
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  tone?: 'danger' | 'warn';
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section
      className={cn(
        'card rounded-[14px] shadow-md',
        tone === 'danger' && 'border-danger-line',
        tone === 'warn' && 'border-warn-line',
        className,
      )}
    >
      <div className="flex flex-col gap-4 p-7">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-[20px] leading-7 font-semibold tracking-[-0.015em] text-text">
            {title}
          </h1>
          {description ? <p className="t-sm text-text-2">{description}</p> : null}
        </div>
        {children}
      </div>
    </section>
  );
}
