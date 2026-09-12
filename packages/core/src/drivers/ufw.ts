import { exec } from '../ssh/client.js';
import type { DriverContext, LogSink } from './types.js';

/**
 * Pare-feu UFW sur la machine cible.
 *
 * Deux principes :
 *
 * 1. **On ne force jamais l'activation.** Un panel qui active le pare-feu d'une
 *    machine qu'il ne connaît pas peut couper la session SSH qui le pilote.
 *    UFW inactif → avertissement, et on continue : le port publié par Docker
 *    est joignable de toute façon, c'est le pare-feu qui ne filtre rien.
 *
 * 2. **La règle est identifiée par son commentaire, pas par son numéro.**
 *    `ufw status numbered` renumérote à chaque suppression : une règle effacée
 *    par index efface la voisine dès qu'une autre est partie entre-temps. Le
 *    commentaire `pupitre:{slug}` est stable, et il dit aussi à
 *    l'administrateur de la machine qui a ouvert ce port et pour quoi.
 */

const UFW_TIMEOUT_MS = 30_000;

/** Marqueur posé sur chaque règle créée par le panel. */
export function ufwComment(appSlug: string): string {
  return `${UFW_MARKER}:${appSlug}`;
}

/**
 * Le préfixe des règles que le panel s'attribue, et celui d'avant le renommage.
 *
 * Ces commentaires sont **écrits dans le pare-feu de la machine cible**, pas
 * chez nous. Une règle ouverte hier porte `bootstrap-tp:`, et si le panel
 * cessait de la reconnaître il cesserait aussi de la refermer : le port
 * resterait ouvert après la destruction de l'application, sans que rien ne le
 * signale. Un renommage ne doit pas laisser de porte ouverte derrière lui.
 *
 * On écrit donc le nouveau et on lit les deux, `UFW_MARKERS` étant la liste que
 * consultent le nettoyage et le preflight.
 */
export const UFW_MARKER = 'pupitre';
export const LEGACY_UFW_MARKER = 'bootstrap-tp';
export const UFW_MARKERS = [UFW_MARKER, LEGACY_UFW_MARKER] as const;

/** La ligne de `ufw status` appartient-elle au panel, toutes générations ? */
export function isManagedUfwRule(line: string): boolean {
  return UFW_MARKERS.some((marker) => line.includes(`${marker}:`));
}

/** Échappement POSIX en quotes simples. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export type UfwState = 'active' | 'inactive' | 'absent';

/**
 * État du pare-feu.
 *
 * `ufw status` exige root : on passe par sudo, et on retombe sur `absent` quand
 * le binaire n'est pas là — ce qui est le cas de bien des images minimales.
 */
export async function ufwState(ctx: DriverContext): Promise<UfwState> {
  const present = await exec(ctx.sshSession, 'command -v ufw >/dev/null 2>&1', {
    timeout: UFW_TIMEOUT_MS,
  });
  if (present.code !== 0) return 'absent';

  const status = await exec(ctx.sshSession, 'ufw status 2>/dev/null || true', {
    sudo: true,
    timeout: UFW_TIMEOUT_MS,
  });
  return /Status:\s*active/i.test(status.stdout) ? 'active' : 'inactive';
}

/**
 * Ouvre `port/tcp` avec le commentaire de l'application.
 *
 * `ufw allow` est idempotent : rejouer la même règle produit
 * « Skipping adding existing rule ». On ne teste donc pas avant d'ajouter.
 */
export async function ufwAllow(
  ctx: DriverContext,
  port: number,
  onLog: LogSink,
): Promise<void> {
  const state = await ufwState(ctx);
  if (state !== 'active') {
    onLog(
      state === 'absent'
        ? `⚠ ufw absent de ${ctx.target.name} — le port ${port} n'est filtré par personne`
        : `⚠ ufw inactif sur ${ctx.target.name} — aucune règle posée pour le port ${port}`,
    );
    return;
  }

  const comment = ufwComment(ctx.appSlug);
  const result = await exec(
    ctx.sshSession,
    `ufw allow ${port}/tcp comment ${shellQuote(comment)}`,
    { sudo: true, timeout: UFW_TIMEOUT_MS },
  );

  if (result.code !== 0) {
    // Un pare-feu qui refuse une règle n'est pas une raison de perdre le
    // déploiement : on le dit fort, on ne l'interrompt pas.
    onLog(`⚠ ufw allow ${port}/tcp a échoué : ${firstLine(result.stderr) ?? `code ${result.code}`}`);
    return;
  }
  onLog(`ufw allow ${port}/tcp (${comment})`);
}

/**
 * Supprime les règles portant le commentaire de l'application.
 *
 * `ufw delete allow <port>/tcp` supprime par correspondance de règle, pas par
 * numéro. On vérifie ensuite que plus rien ne porte notre commentaire sur ce
 * port : c'est le commentaire qui fait foi, il est notre marqueur.
 */
export async function ufwDelete(
  ctx: DriverContext,
  port: number,
  onLog: LogSink,
): Promise<void> {
  const state = await ufwState(ctx);
  if (state !== 'active') {
    onLog(`⚠ ufw ${state === 'absent' ? 'absent' : 'inactif'} — aucune règle à retirer`);
    return;
  }

  const comment = ufwComment(ctx.appSlug);
  const result = await exec(ctx.sshSession, `ufw --force delete allow ${port}/tcp`, {
    sudo: true,
    timeout: UFW_TIMEOUT_MS,
  });

  // La suppression se fait par correspondance de règle (`allow <port>/tcp`),
  // jamais par commentaire : une règle d'avant le renommage est donc retirée
  // comme les autres. Le contrôle qui suit, lui, doit accepter les deux
  // marqueurs — sinon un reliquat portant l'ancien passerait pour une absence,
  // et le port resterait ouvert sans que rien ne le dise.
  const markers = UFW_MARKERS.map((marker) => `${marker}:`).join('|');
  const remaining = await exec(
    ctx.sshSession,
    `ufw status | grep -E ${shellQuote(markers)} | grep -F ${shellQuote(String(port))} || true`,
    { sudo: true, timeout: UFW_TIMEOUT_MS },
  );

  if (remaining.stdout.trim().length > 0) {
    onLog(`⚠ la règle ${port}/tcp (${comment}) est toujours présente : ${remaining.stdout.trim()}`);
    return;
  }
  onLog(
    result.code === 0
      ? `ufw delete allow ${port}/tcp (${comment})`
      : `ufw : plus aucune règle ${port}/tcp (${comment})`,
  );
}

function firstLine(value: string): string | null {
  const line = value.split('\n').find((candidate) => candidate.trim().length > 0);
  return line?.trim() ?? null;
}
