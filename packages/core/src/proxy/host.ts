import { randomBytes } from 'node:crypto';
import { exec, upload } from '../ssh/client.js';
import type { ProxyKind } from './model.js';
import { ProxyError, type ProxyHostContext } from './types.js';
import { firstLine, shellQuote } from '../shell.js';

/**
 * Les gestes sur la machine d'un proxy que tous les providers partagent :
 * créer un dossier, écrire ou retirer un fichier, lire un code HTTP. Par la
 * session SSH de la machine, avec sudo seulement quand il le faut.
 */

const SHORT_MS = 30_000;

/** Crée un dossier ; par sudo, en le rendant au compte de déploiement, si besoin. */
export async function ensureDirectory(
  ctx: ProxyHostContext,
  directory: string,
  kind: ProxyKind,
): Promise<void> {
  const direct = await exec(ctx.sshSession, `mkdir -p ${shellQuote(directory)}`, {
    timeout: SHORT_MS,
  });
  if (direct.code === 0) return;
  const identity = await exec(ctx.sshSession, 'echo "$(id -u):$(id -g)"', { timeout: SHORT_MS });
  const owner = identity.stdout.trim();
  const elevated = await exec(
    ctx.sshSession,
    `mkdir -p ${shellQuote(directory)} && chown ${owner} ${shellQuote(directory)}`,
    { sudo: true, timeout: SHORT_MS },
  );
  if (elevated.code !== 0) {
    throw new ProxyError(
      `${directory} : ${firstLine(elevated.stderr) ?? firstLine(direct.stderr) ?? 'création impossible'}`,
      kind,
      'directory',
    );
  }
}

/**
 * Écrit un fichier. Directement d'abord ; un dossier qui appartient à root —
 * celui d'un proxy installé à la main, typiquement — passe par un fichier
 * temporaire et `sudo install`.
 */
export async function writeFile(
  ctx: ProxyHostContext,
  path: string,
  content: string,
  kind: ProxyKind,
): Promise<void> {
  try {
    await upload(ctx.sshSession, Buffer.from(content, 'utf8'), path);
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/permission denied|eacces/i.test(message)) throw error;
  }
  const temporary = `/tmp/pupitre-${randomBytes(6).toString('hex')}`;
  await upload(ctx.sshSession, Buffer.from(content, 'utf8'), temporary);
  const moved = await exec(
    ctx.sshSession,
    `install -m 0644 ${shellQuote(temporary)} ${shellQuote(path)}; code=$?; rm -f ${shellQuote(temporary)}; exit $code`,
    { sudo: true, timeout: SHORT_MS },
  );
  if (moved.code !== 0) {
    throw new ProxyError(
      `${path} : ${firstLine(moved.stderr) ?? 'écriture refusée'}`,
      kind,
      'write',
    );
  }
}

export async function removeFile(
  ctx: ProxyHostContext,
  path: string,
  kind: ProxyKind,
): Promise<void> {
  const direct = await exec(ctx.sshSession, `rm -f ${shellQuote(path)}`, { timeout: SHORT_MS });
  if (direct.code === 0) return;
  const elevated = await exec(ctx.sshSession, `rm -f ${shellQuote(path)}`, {
    sudo: true,
    timeout: SHORT_MS,
  });
  if (elevated.code !== 0) {
    throw new ProxyError(
      `${path} : ${firstLine(elevated.stderr) ?? 'suppression refusée'}`,
      kind,
      'remove',
    );
  }
}

/** Un code HTTP lu sur la machine, `0` quand rien ne répond. */
export async function httpCode(ctx: ProxyHostContext, url: string, host?: string): Promise<number> {
  const header = host ? ` -H ${shellQuote(`Host: ${host}`)}` : '';
  const result = await exec(
    ctx.sshSession,
    `curl -s -k -o /dev/null -w '%{http_code}' -m 5${header} ${shellQuote(url)} || true`,
    { timeout: SHORT_MS },
  );
  return Number(result.stdout.trim()) || 0;
}
