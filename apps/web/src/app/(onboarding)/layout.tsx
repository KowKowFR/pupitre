import type { ReactNode } from 'react';
import { currentAuth, redirectToLogin } from '@/lib/page-auth';

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
 * L'en-tête, lui, est posé par la page : sa partie droite dépend de l'étape.
 */
export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  // Pas de session valide : direction la connexion (par `/logout` si un cookie périmé traîne).
  if (!(await currentAuth())) await redirectToLogin();

  return <div className="min-h-dvh bg-bg">{children}</div>;
}
