/**
 * Confirmation à la mesure du risque — les trois niveaux du design system.
 *
 *   1. `reversible` : arrêter, redémarrer, suspendre. Dialogue court, verbe en
 *      primaire.
 *   2. `trace` : purger un historique, supprimer un objet vide. Conséquences
 *      listées, bouton destructif au trait.
 *   3. `data` : détruire une app sur sa cible, supprimer une app vivante,
 *      forcer l'effacement. Il faut **retaper le nom** ; le bouton rouge plein
 *      reste désactivé tant que la saisie ne correspond pas exactement.
 *
 * Ce module est pur : il sert au dialogue et aux tests.
 */

export type ConfirmLevel = 'reversible' | 'trace' | 'data';

/**
 * La saisie débloque-t-elle la confirmation ? Correspondance exacte, casse
 * comprise : `Blog` ne débloque pas `blog`. Seuls les blancs de tête et de
 * queue sont tolérés, parce qu'un copier-coller en ramène souvent un.
 */
export function confirmMatches(typed: string, expected: string): boolean {
  return expected.length > 0 && typed.trim() === expected;
}

/** Le verbe final prend la variante du niveau. */
export function confirmVariant(
  level: ConfirmLevel,
): 'default' | 'destructive' | 'destructive-solid' {
  if (level === 'data') return 'destructive-solid';
  if (level === 'trace') return 'destructive';
  return 'default';
}
