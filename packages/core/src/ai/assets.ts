import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';

/**
 * Lecture des ressources versionnées de `packages/core` — le prompt système et
 * les fixtures d'AppSpec.
 *
 * Le problème est plus subtil qu'il n'y paraît. Ces fichiers sont lus depuis
 * **trois** contextes d'exécution qui ne voient pas le même arbre :
 *
 *   1. les sources, sous `tsx` (tests, scripts) — `src/ai/…`
 *   2. le paquet compilé, sous Node (worker, image Docker) — `dist/ai/…`,
 *      où `tsc` ne copie pas les `.md` ni les `.json` : c'est le script `build`
 *      de `packages/core` qui les recopie à côté du JavaScript émis
 *   3. le panel Next, où `@pupitre/core` est **inliné** dans les chunks du serveur.
 *      `import.meta.url` désigne alors un chunk de `.next/server`, et aucune
 *      résolution relative au module ne peut aboutir. Next recopie en revanche
 *      les fichiers déclarés dans `outputFileTracingIncludes` en préservant leur
 *      chemin depuis la racine du monorepo, et son serveur `standalone` fait un
 *      `process.chdir()` vers `apps/web` : le fichier est donc à une position
 *      connue *relativement au répertoire courant*.
 *
 * D'où une liste de candidats plutôt qu'un chemin unique.
 *
 * ── Pourquoi une validation de contenu, et pas seulement « le fichier existe » ─
 * Turbopack **réécrit** `new URL(…, import.meta.url)` dans les modules qu'il
 * inline. Le chemin obtenu à l'exécution ne pointe plus sur la ressource
 * demandée mais sur un module émis dans `.next/server/assets/`. Le
 * `readFileSync` réussit alors parfaitement — et rend le code source d'un
 * module JavaScript à la place du prompt. Constaté, pas supposé : la sonde de
 * santé annonçait un prompt de 1 701 octets là où il en fait 9 966.
 *
 * Un candidat n'est donc retenu que si son contenu **ressemble à ce qu'on a
 * demandé**. Sans cela, l'erreur est silencieuse : le panel part en production
 * avec un prompt système qui est un bout de TypeScript, et le modèle répond
 * n'importe quoi sans que rien n'ait échoué.
 *
 * L'échec complet nomme tout ce qui a été tenté — un prompt manquant en
 * production doit se diagnostiquer en lisant le message, pas en fouillant
 * l'image.
 */

/** Chemin d'une ressource, relatif à `packages/core/src`. */
export type CoreAssetPath = `${string}/${string}`;

function candidatesFor(asset: CoreAssetPath): string[] {
  const candidates: string[] = [];

  // (1) et (2) : à côté du module, que l'on tourne depuis `src` ou depuis `dist`.
  // `../` remonte de `ai/` vers la racine du paquet compilé ou des sources.
  try {
    candidates.push(fileURLToPath(new URL(`../${asset}`, import.meta.url)));
  } catch {
    // `import.meta.url` peut ne pas être un `file:` (bundler) : on passe.
  }

  // (3) : depuis le répertoire courant. `apps/web` sous `next dev` comme sous
  // le serveur `standalone`, ou la racine du monorepo pour un script.
  const cwd = process.cwd();
  candidates.push(
    resolve(cwd, '../../packages/core/src', asset),
    resolve(cwd, '../../packages/core/dist', asset),
    resolve(cwd, 'packages/core/src', asset),
    resolve(cwd, 'packages/core/dist', asset),
  );

  return candidates;
}

const cache = new Map<string, string>();

export type ReadAssetOptions = {
  /**
   * Reconnaît le contenu attendu. Un candidat qui échoue est écarté comme s'il
   * n'existait pas, et la recherche continue. **Obligatoire en pratique** :
   * voir l'explication ci-dessus sur la réécriture par Turbopack.
   */
  looksRight: (content: string) => boolean;
  /** Nommé dans le message d'erreur, pour dire ce qu'on cherchait. */
  expectation: string;
};

/** Lit une ressource versionnée. Le résultat est mémoïsé : elle ne change pas. */
export function readCoreAsset(asset: CoreAssetPath, options: ReadAssetOptions): string {
  // La mémoïsation porte sur le couple (ressource, attente) et non sur la seule
  // ressource : deux appelants qui n'attendent pas la même chose ne doivent pas
  // se partager un résultat, sans quoi le premier — potentiellement laxiste —
  // décide pour le second ce qui est acceptable.
  const cacheKey = `${asset}\u0000${options.expectation}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const tried: string[] = [];
  const rejected: string[] = [];

  for (const candidate of candidatesFor(asset)) {
    if (!isAbsolute(candidate)) continue;
    tried.push(candidate);

    let content: string;
    try {
      content = readFileSync(candidate, 'utf8');
    } catch {
      continue; // candidat suivant
    }

    if (!options.looksRight(content)) {
      rejected.push(`${candidate} (lu, mais ${options.expectation} manque)`);
      continue;
    }

    cache.set(cacheKey, content);
    return content;
  }

  const detail = [...rejected, ...tried.filter((path) => !rejected.some((r) => r.startsWith(path)))];
  throw new Error(
    `ressource « ${asset} » introuvable ou méconnaissable dans @pupitre/core ` +
      `(attendu : ${options.expectation}). Chemins tentés :\n  ${detail.join('\n  ')}`,
  );
}
