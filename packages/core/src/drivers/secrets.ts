import {
  secretBindings,
  secretNamesOf,
  secretRootName,
  storedSecretNames,
  type AppSpec,
} from '../spec/index.js';
import type { UiLanguage } from '../i18n.js';
import { driverSay } from './messages.js';

/**
 * Résolution des valeurs de secrets, au moment du rendu.
 *
 * L'AppSpec ne déclare que des **noms** : les valeurs vivent chiffrées en base
 * et sont fournies par l'appelant via `DriverContext.resolveSecrets`. Ce module
 * est le seul point où l'on décide ce qui se passe quand une valeur manque, et
 * il est partagé par les deux rendus pour qu'ils ne puissent pas diverger.
 *
 * ── Les alias se résolvent ici, pas dans un driver ──────────────────────────
 *
 * Un secret peut déclarer qu'il reprend la valeur d'un autre (`{ name, from }`)
 * — c'est ce qui permet à `mariadb:11` et à `wordpress` de partager un mot de
 * passe qu'ils lisent sous deux noms différents. La chaîne d'alias est suivie
 * **ici**, dans le code neutre, et les deux drivers reçoivent une carte déjà
 * complète, où chaque nom déclaré a sa valeur. Compose aurait su interpoler
 * `${MARIADB_PASSWORD}` depuis le `.env` ; Kubernetes n'interpole rien. Résoudre
 * avant le rendu est la seule façon que la même AppSpec marche des deux côtés.
 */

/** Un secret déclaré par la spec dont l'appelant n'a fourni aucune valeur. */
export class UnresolvedSecretError extends Error {
  override readonly name = 'UnresolvedSecretError';

  constructor(
    readonly names: readonly string[],
    language: UiLanguage = 'fr',
  ) {
    super(driverSay(language)('secrets.unresolved', { names: names.join(', ') }));
  }
}

/** Noms de secrets déclarés par la spec, alias compris, dédoublonnés. */
export function declaredSecretNames(spec: AppSpec): string[] {
  return secretNamesOf(spec);
}

/**
 * Noms dont l'appelant doit fournir une valeur.
 *
 * Les racines uniquement : un alias n'a pas de valeur propre, il n'a donc rien
 * à demander au magasin — et surtout rien à y créer. C'est cette liste que les
 * drivers passent à `resolveSecrets`.
 */
export { storedSecretNames };

/**
 * Complète la table des valeurs pour tous les secrets déclarés, et **échoue**
 * si l'un d'eux n'a pas été résolu.
 *
 * Entrée : les valeurs des **racines**, telles que le magasin les rend.
 * Sortie : une valeur par nom **déclaré**, alias compris — deux noms liés par
 * un alias y portent donc, littéralement, la même chaîne.
 *
 * Le test porte sur la *présence de la clé*, jamais sur la valeur : un secret
 * délibérément vide reste légitime — certaines images distinguent « variable
 * absente » de « variable vide » — alors qu'un secret absent de la table
 * signifie que personne n'a su répondre. Écrire `''` dans les deux cas, comme le
 * faisait le rendu Docker, transformait une erreur nommable en panne obscure
 * trois étapes plus loin : PostgreSQL refusant de s'initialiser, puis le
 * `depends_on: service_healthy` du service applicatif bloquant pour toujours.
 */
export function completeSecretValues(
  spec: AppSpec,
  values: Readonly<Record<string, string>> = {},
  language: UiLanguage = 'fr',
): Record<string, string> {
  const bindings = secretBindings(spec);
  const complete: Record<string, string> = {};
  const missing = new Set<string>();

  for (const name of declaredSecretNames(spec)) {
    // Le nom qui porte réellement la valeur — lui-même, sauf pour un alias.
    const root = secretRootName(bindings, name);
    if (Object.hasOwn(values, root)) {
      complete[name] = values[root] as string;
    } else {
      // On nomme la racine : c'est elle qu'il faut renseigner, pas l'alias.
      missing.add(root);
    }
  }

  if (missing.size > 0) throw new UnresolvedSecretError([...missing], language);
  return complete;
}
