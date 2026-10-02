/**
 * Une écriture vient-elle du panel lui-même ?
 *
 * Le cookie de session est `SameSite=Lax` : un navigateur ne l'envoie pas avec
 * un formulaire posté depuis un autre **site**. Mais un site, c'est un domaine
 * enregistrable entier : `blog.exemple.fr` et `pupitre.exemple.fr` en sont un
 * seul. Or Pupitre déploie justement des sites, souvent sur des sous-domaines
 * voisins du panel — une page piégée là-bas, ouverte par un administrateur
 * connecté, lui ferait poster ce qu'elle veut, cookie compris.
 *
 * Toute requête d'écriture d'un navigateur porte l'en-tête `Origin` (les
 * navigateurs récents l'envoient aussi en même origine), et le plus souvent
 * `Sec-Fetch-Site` : on exige que l'un ou l'autre dise « le panel ». Une
 * requête qui ne porte ni l'un ni l'autre ne vient pas d'un navigateur —
 * `curl`, un script, le worker — et n'a pas de cookie à détourner : elle passe.
 *
 * Module pur, sans `server-only` : il se teste sans serveur.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * La raison pour laquelle cette requête est refusée, ou `null` si elle vient
 * du panel (ou n'écrit rien). `panelOrigin` : celle de `BETTER_AUTH_URL`.
 */
export function foreignWrite(
  request: { method: string; headers: Pick<Headers, 'get'> },
  panelOrigin: string,
): string | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;

  const origin = request.headers.get('origin');
  if (origin !== null) {
    // `null` en toutes lettres : une page en bac à sable, un `data:` — jamais le panel.
    return origin === panelOrigin ? null : `origine ${origin}`;
  }

  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') {
    return `Sec-Fetch-Site ${site}`;
  }
  return null;
}

/** L'origine d'une URL de base (`https://pupitre.exemple.fr/` → `https://pupitre.exemple.fr`). */
export function originOf(url: string): string {
  return new URL(url).origin;
}
