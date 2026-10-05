import { exec } from '../ssh/client.js';
import type { DriverContext, LogSink } from './types.js';
import { shellQuote } from '../shell.js';
import { driverSay } from './messages.js';

/**
 * Rétention des répertoires de version sur la cible.
 *
 * Chaque déploiement dépose une release dans `{appPath}/{version}`. Sans
 * ménage, une cible finit par porter l'intégralité de l'historique — et un
 * rollback n'a besoin que de l'avant-dernière.
 *
 * Le ménage est fait **au déploiement suivant**, pas au destroy : c'est le seul
 * moment où l'on sait quelle release vient de devenir la courante.
 *
 * Le code vit ici parce que les deux drivers ont exactement le même problème et
 * la même arborescence. Ce n'est pas une divergence de runtime : c'est du
 * ménage de fichiers, et un troisième driver le réutiliserait tel quel.
 */

export const RELEASES_KEPT = 5;

const PRUNE_TIMEOUT_MS = 60_000;

/**
 * Supprime les répertoires de version les plus anciens, en gardant les
 * `keep` plus récents et **toujours** celui vers lequel pointe `current`.
 *
 * Le tri se fait sur la date de modification (`ls -1dt`) et non sur le nom : une
 * version sémantique ne s'ordonne pas lexicographiquement (`1.10.0` < `1.9.0`),
 * et c'est l'ordre de déploiement qui compte ici, pas l'ordre des versions.
 */
export async function pruneReleases(
  ctx: DriverContext,
  appPath: string,
  onLog: LogSink,
  keep: number = RELEASES_KEPT,
): Promise<string[]> {
  const script = [
    `cd ${shellQuote(appPath)} 2>/dev/null || exit 0`,
    // Résolution du lien `current` : la release active ne doit jamais partir,
    // même si son répertoire est ancien — c'est exactement le cas après un
    // rollback.
    'CUR=""',
    'if [ -L current ]; then CUR=$(basename "$(readlink -f current)"); fi',
    // `ls -1dt */` liste les répertoires du plus récent au plus ancien.
    //
    // Les scripts `sed` et `grep` sont en quotes SIMPLES, et ce n'est pas une
    // question de style : entre quotes doubles, le shell verrait `$#` dans
    // `s#/$##` et y substituerait le nombre d'arguments positionnels. `sed`
    // recevrait alors `s#/0#`, se plaindrait d'un délimiteur non apparié, et le
    // ménage ne supprimerait plus jamais rien — en silence.
    "ls -1dt */ 2>/dev/null | sed 's#/$##' | grep -v '^current$' | {",
    '  KEPT=0',
    '  while IFS= read -r dir; do',
    '    [ -z "$dir" ] && continue',
    '    if [ "$dir" = "$CUR" ]; then KEPT=$((KEPT+1)); continue; fi',
    `    if [ "$KEPT" -lt ${keep} ]; then KEPT=$((KEPT+1)); continue; fi`,
    '    rm -rf -- "$dir" && echo "$dir"',
    '  done',
    '}',
  ].join('\n');

  const result = await exec(ctx.sshSession, script, { timeout: PRUNE_TIMEOUT_MS });
  const removed = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (removed.length > 0) {
    onLog(
      driverSay(ctx.language)('retention.removed', {
        count: removed.length,
        releases: removed.join(', '),
      }),
    );
  }
  return removed;
}
