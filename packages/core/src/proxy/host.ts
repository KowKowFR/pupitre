import { randomBytes } from 'node:crypto';
import { exec, upload } from '../ssh/client.js';
import type { ProxyKind } from './model.js';
import { ProxyError, type ProxyHostContext } from './types.js';
import { firstLine, shellQuote } from '../shell.js';
import { proxySay } from './messages.js';

/**
 * The gestures on a proxy's machine that every provider shares: create a
 * folder, write or remove a file, read an HTTP code. Through the machine's SSH
 * session, with sudo only when needed.
 */

const SHORT_MS = 30_000;

/** Creates a folder; through sudo, handing it to the deployment account, if needed. */
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
      `${directory} : ${firstLine(elevated.stderr) ?? firstLine(direct.stderr) ?? proxySay(ctx.language)('host.mkdirFailed')}`,
      kind,
      'directory',
    );
  }
}

/**
 * Writes a file. Directly first; a folder owned by root — that of a proxy
 * installed by hand, typically — goes through a temporary file and
 * `sudo install`.
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
      `${path} : ${firstLine(moved.stderr) ?? proxySay(ctx.language)('host.writeRefused')}`,
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
      `${path} : ${firstLine(elevated.stderr) ?? proxySay(ctx.language)('host.removeRefused')}`,
      kind,
      'remove',
    );
  }
}

/** An HTTP code read on the machine, `0` when nothing answers. */
export async function httpCode(ctx: ProxyHostContext, url: string, host?: string): Promise<number> {
  const header = host ? ` -H ${shellQuote(`Host: ${host}`)}` : '';
  const result = await exec(
    ctx.sshSession,
    `curl -s -k -o /dev/null -w '%{http_code}' -m 5${header} ${shellQuote(url)} || true`,
    { timeout: SHORT_MS },
  );
  return Number(result.stdout.trim()) || 0;
}
