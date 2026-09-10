import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { getAppSettings } from '@tp/db';
import { currentAuth } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

/**
 * Coquille de l'assistant de démarrage — délibérément nue.
 *
 * L'assistant vit hors du groupe `(app)` pour une raison de fond : il n'a pas
 * de barre de navigation. Proposer d'aller aux cibles, aux applications ou aux
 * rôles pendant qu'on explique comment déclarer sa première cible, c'est
 * offrir douze façons de se perdre dans un panel qu'on découvre. Le parcours
 * est linéaire, l'écran doit l'être aussi.
 *
 * Ce n'est pas seulement cosmétique. Tant que l'assistant était imbriqué dans
 * `(app)`, il en héritait le layout — donc le rail — et la redirection devait
 * composer avec un layout qui se réexécutait à l'arrivée. Le sortir du groupe
 * supprime les deux problèmes d'un coup.
 *
 * Le prix : l'authentification est refaite ici. C'est peu, et c'est explicite.
 */
export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  const auth = await currentAuth();
  if (!auth) redirect('/login');

  const { settings } = await getAppSettings();

  return (
    <div className="bg-canvas min-h-dvh">
      <header className="border-line border-b">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2.5 px-4 py-4 sm:px-6">
          <span
            aria-hidden
            className="bg-signal shadow-panel flex size-7 shrink-0 items-center justify-center rounded-[5px]"
          >
            <span className="bg-signal-ink size-2 rounded-[1px]" />
          </span>
          <span className="flex flex-col leading-none">
            <span className="font-condensed text-ink text-[0.9375rem] font-semibold tracking-[0.01em]">
              {settings.instanceName}
            </span>
            <span className="eyebrow text-ink-faint pt-1">Premiers pas</span>
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 lg:py-12">{children}</main>
    </div>
  );
}
