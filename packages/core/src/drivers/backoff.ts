/**
 * Attente entre deux sondes de santé.
 *
 * `intervalSec` est doublé à chaque tentative, puis plafonné. Une application
 * qui met une minute à démarrer n'a pas besoin d'être interrogée trente fois en
 * trente secondes ; une qui répond tout de suite ne doit pas attendre une
 * minute pour rien. Sans plafond, la cinquième tentative attendrait déjà seize
 * fois l'intervalle demandé — le réglage de l'AppSpec n'aurait plus aucun sens.
 *
 * Partagé par les deux drivers : la temporisation d'une sonde n'a rien de
 * spécifique à un runtime.
 */

/** Plafond du backoff exponentiel, en secondes. */
export const BACKOFF_CAP_SEC = 30;

export function backoffMs(intervalSec: number, attempt: number): number {
  const capped = Math.min(intervalSec * 2 ** (attempt - 1), BACKOFF_CAP_SEC);
  return Math.round(capped * 1000);
}
