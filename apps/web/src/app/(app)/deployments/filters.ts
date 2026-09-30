/**
 * Les filtres de la liste des runs, partagés par la page (serveur), la table
 * (client) et le lien d'export : les trois doivent écrire la même URL.
 *
 * Trois filtres sont des statuts ; « bloqués par un scan » n'en est pas un —
 * c'est un échec avec une cause précise, que la liste traduit en `blocked=scan`.
 */
export type StatusFilter = 'running' | 'failed' | 'rolled_back' | 'scan_blocked' | null;

/** Les paramètres d'URL d'un filtre : ceux de la liste, repris tels quels par l'export. */
export function filterParams(filter: StatusFilter, search: string): URLSearchParams {
  const params = new URLSearchParams();
  if (filter === 'scan_blocked') params.set('blocked', 'scan');
  else if (filter) params.set('status', filter);
  if (search) params.set('q', search);
  return params;
}
