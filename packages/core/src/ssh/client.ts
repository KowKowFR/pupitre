import { createHash, randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { NodeSSH } from 'node-ssh';
import type { ClientChannel } from 'ssh2';
import {
  SshConfigError,
  SshConnectionError,
  SshHostKeyError,
  SshTimeoutError,
  isAuthFailure,
  SshAuthError,
} from './errors.js';
import type {
  ConnectOptions,
  ExecOptions,
  ExecResult,
  SshLogger,
  SshTarget,
} from './types.js';
import { shellQuote } from '../shell.js';
import type { UiLanguage } from '../i18n.js';
import { sshSay } from './messages.js';

export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
export const DEFAULT_READY_TIMEOUT_MS = 15_000;
export const DEFAULT_RETRIES = 3;

/** Open session. Opaque to the caller: everything goes through the module's functions. */
export type SshSession = {
  readonly id: string;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly connectedAt: Date;
  /** Time to establish the connection, in milliseconds. */
  readonly latencyMs: number;
  /** The fingerprint of the presented host key (`SHA256:…`). */
  readonly hostKey: string | null;
  /** @internal */
  readonly client: NodeSSH;
  /** @internal */
  readonly target: SshTarget;
  /** @internal */
  readonly logger: SshLogger | undefined;
  /** The language of what the session says — see `ConnectOptions.language`. */
  readonly language: UiLanguage;
};

const noopLogger: SshLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A host key's fingerprint, in `ssh-keygen -lf` format: `SHA256:` then the
 * SHA-256 of the public key blob, in base64 without `=`.
 */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/**
 * Opens an SSH session.
 *
 * Retries up to `retries` times with exponential backoff on a network failure.
 * **Never** on an authentication failure: the key will not become valid by
 * retrying, and some targets ban the IP after a few attempts.
 */
export async function connect(
  target: SshTarget,
  options: ConnectOptions = {},
): Promise<SshSession> {
  const logger = options.logger ?? noopLogger;
  const say = sshSay(options.language ?? 'fr');
  const retries = options.retries ?? DEFAULT_RETRIES;
  const readyTimeout = options.readyTimeout ?? DEFAULT_READY_TIMEOUT_MS;

  // The presented key, recorded at each attempt; refused if it is not the one
  // expected — `ssh2` then cuts the handshake.
  const policy = target.hostKey;
  let presented: string | null = null;
  const base = {
    host: target.host,
    port: target.port,
    username: target.username,
    readyTimeout,
    keepaliveInterval: 10_000,
    hostVerifier: (key: Buffer) => {
      presented = hostKeyFingerprint(key);
      return !policy?.expected || presented === policy.expected;
    },
  };

  const config =
    target.credentials.authMethod === 'key'
      ? {
          ...base,
          privateKey: target.credentials.privateKey,
          ...(target.credentials.passphrase
            ? { passphrase: target.credentials.passphrase }
            : {}),
        }
      : { ...base, password: target.credentials.password };

  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const client = new NodeSSH();
    const startedAt = Date.now();
    presented = null;

    try {
      await client.connect(config);
      const latencyMs = Date.now() - startedAt;

      // A machine never reached: its key is recorded, and expected from now on.
      if (policy && policy.expected === null && presented) {
        await policy.onFirstSeen?.(presented);
      }

      logger.info(
        {
          host: target.host,
          port: target.port,
          username: target.username,
          authMethod: target.credentials.authMethod,
          latencyMs,
          attempt,
        },
        'session SSH ouverte',
      );

      return {
        id: randomUUID(),
        host: target.host,
        port: target.port,
        username: target.username,
        connectedAt: new Date(),
        latencyMs,
        hostKey: presented,
        client,
        target,
        logger: options.logger,
        language: options.language ?? 'fr',
      };
    } catch (error) {
      lastError = error;
      client.dispose();

      // `presented` is reassigned by the verifier, called during `connect`.
      const seen = presented as string | null;
      if (policy?.expected && seen && seen !== policy.expected) {
        logger.warn(
          { host: target.host, expected: policy.expected, presented: seen },
          'unexpected host key — connection refused, no retry',
        );
        await policy.onMismatch?.(seen);
        throw new SshHostKeyError(target.host, policy.expected, seen, options.language);
      }

      if (isAuthFailure(error)) {
        logger.warn(
          { host: target.host, authMethod: target.credentials.authMethod },
          'SSH authentication failed — no retry',
        );
        throw new SshAuthError(say('auth.refused'), target.host, error);
      }

      const isLast = attempt === retries;
      logger.warn(
        {
          host: target.host,
          attempt,
          retries,
          error: error instanceof Error ? error.message : String(error),
        },
        isLast ? 'connexion SSH abandonnée' : 'connexion SSH échouée, nouvelle tentative',
      );

      if (!isLast) {
        // Backoff exponentiel : 500 ms, 1 s, 2 s…
        await sleep(500 * 2 ** (attempt - 1));
      }
    }
  }

  throw new SshConnectionError(
    say('connect.failed', { host: target.host, port: target.port, retries }),
    target.host,
    lastError,
  );
}

/**
 * Wraps a command with `sudo` according to the method declared on the target.
 * `nopasswd` → `sudo -n`; `password` → `sudo -S` fed through stdin.
 */
function withSudo(session: SshSession, command: string): { command: string; stdin?: string } {
  if (session.target.sudoMethod === 'nopasswd') {
    return { command: `sudo -n -- sh -c ${shellQuote(command)}` };
  }

  if (session.target.credentials.authMethod !== 'password') {
    throw new SshConfigError(sshSay(session.language)('sudo.passwordWithKey'), session.host);
  }

  // The password goes through stdin, never through the command line: it
  // therefore appears neither in `ps` nor in the remote shell's history.
  return {
    command: `sudo -S -p '' -- sh -c ${shellQuote(command)}`,
    stdin: `${session.target.credentials.password}\n`,
  };
}

/**
 * Runs a command and returns its complete result. A non-zero exit code is not
 * an error: it is information the caller interprets (a missing `docker` returns
 * 127, which is not a preflight failure).
 */
export async function exec(
  session: SshSession,
  command: string,
  options: ExecOptions = {},
): Promise<ExecResult> {
  const logger = session.logger ?? noopLogger;
  // `??` would confuse `null` — guard disarmed, deliberately — with "not provided".
  const timeout = options.timeout === undefined ? DEFAULT_EXEC_TIMEOUT_MS : options.timeout;
  const prepared = options.sudo ? withSudo(session, command) : { command };
  const startedAt = Date.now();

  logger.debug(
    { host: session.host, sessionId: session.id, command, sudo: options.sudo === true, timeout },
    'SSH exec',
  );

  const run = session.client.execCommand(prepared.command, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(prepared.stdin ? { stdin: prepared.stdin } : {}),
  });

  let timer: NodeJS.Timeout | undefined;
  // `timeout: null`: no guard. Nothing is put in the race then, otherwise the
  // promise would hang forever.
  const guard =
    timeout === null
      ? null
      : new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new SshTimeoutError(
                sshSay(session.language)('command.interrupted', { ms: timeout }),
                session.host,
              ),
            );
          }, timeout);
        });

  try {
    const response = guard === null ? await run : await Promise.race([run, guard]);
    const result: ExecResult = {
      code: response.code ?? -1,
      stdout: response.stdout,
      stderr: response.stderr,
      timedOut: false,
      durationMs: Date.now() - startedAt,
    };

    if (options.logOutput !== false) {
      // The output goes through the Pino `redact` configured by the caller.
      logger.debug(
        {
          host: session.host,
          command,
          code: result.code,
          durationMs: result.durationMs,
          stdout: truncate(result.stdout),
          stderr: truncate(result.stderr),
        },
        'SSH command done',
      );
    } else {
      logger.debug(
        { host: session.host, code: result.code, durationMs: result.durationMs },
        'SSH command done (output not logged)',
      );
    }

    return result;
  } catch (error) {
    if (error instanceof SshTimeoutError) {
      logger.warn({ host: session.host, command, timeout }, 'commande SSH en timeout');
      return {
        code: -1,
        stdout: '',
        stderr: sshSay(session.language)('command.timedOut', { ms: timeout ?? 0 }),
        timedOut: true,
        durationMs: Date.now() - startedAt,
      };
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs a command streaming its output line by line. Used to push deployment
 * logs onto Redis pub/sub.
 */
export async function execStream(
  session: SshSession,
  command: string,
  onLine: (line: string, stream: 'stdout' | 'stderr') => void,
  options: ExecOptions = {},
): Promise<ExecResult> {
  const logger = session.logger ?? noopLogger;
  // `??` would confuse `null` — guard disarmed, deliberately — with "not provided".
  const timeout = options.timeout === undefined ? DEFAULT_EXEC_TIMEOUT_MS : options.timeout;
  const prepared = options.sudo ? withSudo(session, command) : { command };
  const startedAt = Date.now();

  logger.debug(
    { host: session.host, sessionId: session.id, command, sudo: options.sudo === true },
    'SSH streaming exec',
  );

  /** Splits a byte stream into complete lines. */
  const makeSplitter = (stream: 'stdout' | 'stderr') => {
    let buffer = '';
    return (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        onLine(buffer.slice(0, index).replace(/\r$/, ''), stream);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
    };
  };

  const run = session.client.execCommand(prepared.command, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(prepared.stdin ? { stdin: prepared.stdin } : {}),
    onStdout: makeSplitter('stdout'),
    onStderr: makeSplitter('stderr'),
  });

  let timer: NodeJS.Timeout | undefined;
  // `timeout: null`: no guard. Nothing is put in the race then, otherwise the
  // promise would hang forever.
  const guard =
    timeout === null
      ? null
      : new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new SshTimeoutError(
                sshSay(session.language)('command.interrupted', { ms: timeout }),
                session.host,
              ),
            );
          }, timeout);
        });

  try {
    const response = guard === null ? await run : await Promise.race([run, guard]);
    return {
      code: response.code ?? -1,
      stdout: response.stdout,
      stderr: response.stderr,
      timedOut: false,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (error instanceof SshTimeoutError) {
      return {
        code: -1,
        stdout: '',
        stderr: sshSay(session.language)('command.timedOut', { ms: timeout ?? 0 }),
        timedOut: true,
        durationMs: Date.now() - startedAt,
      };
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type PipeOptions = {
  /** Receives the raw stdout — bytes, not lines. Ended at the end of the command. */
  stdout?: Writable;
  /** Feeds stdin; its end closes the remote command's input. */
  stdin?: Readable;
  /** Milliseconds. `null`: no guard. Default: six hours. */
  timeout?: number | null;
};

export type PipeResult = {
  code: number;
  /** The last kilobytes of stderr, to say why. */
  stderr: string;
  timedOut: boolean;
  durationMs: number;
};

const PIPE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const STDERR_TAIL_BYTES = 8 * 1024;

/**
 * Runs a command plugging in its **byte** streams — a volume archive going out,
 * a database export coming in. `exec()` and `execStream()` accumulate or split
 * text: a multi-gigabyte `tar` has no place there.
 *
 * Backpressure is honored both ways: a slow upload to the storage slows down
 * reading on the target instead of keeping everything in memory. No `sudo`
 * here: the commands that go through it (`docker`, `kubectl`) run as the
 * target's user, like the rest of the drivers.
 */
export async function execPipe(
  session: SshSession,
  command: string,
  options: PipeOptions = {},
): Promise<PipeResult> {
  const logger = session.logger ?? noopLogger;
  const connection = session.client.connection;
  if (!connection) {
    throw new SshConnectionError(
      sshSay(session.language)('session.closed'),
      session.host,
      undefined,
    );
  }
  const timeout = options.timeout === undefined ? PIPE_TIMEOUT_MS : options.timeout;
  const startedAt = Date.now();
  logger.debug({ host: session.host, sessionId: session.id, command }, 'SSH piped exec');

  const channel = await new Promise<ClientChannel>((resolve, reject) => {
    connection.exec(command, (error, opened) => (error ? reject(error) : resolve(opened)));
  });

  let stderr = '';
  channel.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
  });

  let code = -1;
  const closed = new Promise<void>((resolve) => {
    channel.on('exit', (exitCode: number | null) => {
      code = exitCode ?? -1;
    });
    channel.on('close', () => resolve());
  });

  let timedOut = false;
  const timer =
    timeout === null
      ? null
      : setTimeout(() => {
          timedOut = true;
          channel.close();
        }, timeout);

  try {
    const flows: Promise<void>[] = [closed];
    if (options.stdout) flows.push(pipeline(channel, options.stdout));
    else channel.resume();
    if (options.stdin) flows.push(pipeline(options.stdin, channel));
    else channel.end();
    await Promise.all(flows);
  } catch (error) {
    channel.close();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }

  return { code, stderr, timedOut, durationMs: Date.now() - startedAt };
}

/** Uploads a local file or in-memory content to the target. */
export async function upload(
  session: SshSession,
  source: string | Buffer,
  remotePath: string,
): Promise<void> {
  const logger = session.logger ?? noopLogger;

  if (typeof source === 'string') {
    await session.client.putFile(source, remotePath);
  } else {
    await session.client.withSFTP(
      (sftp) =>
        new Promise<void>((resolve, reject) => {
          const stream = sftp.createWriteStream(remotePath);
          stream.on('error', reject);
          stream.on('close', resolve);
          stream.end(source);
        }),
    );
  }

  logger.debug(
    {
      host: session.host,
      remotePath,
      bytes: typeof source === 'string' ? undefined : source.byteLength,
    },
    'file uploaded',
  );
}

export async function disconnect(session: SshSession): Promise<void> {
  session.client.dispose();
  (session.logger ?? noopLogger).debug(
    { host: session.host, sessionId: session.id },
    'session SSH fermée',
  );
}

/** Opens a session, runs `run`, then closes no matter what. */
export async function withSession<T>(
  target: SshTarget,
  run: (session: SshSession) => Promise<T>,
  options: ConnectOptions = {},
): Promise<T> {
  const session = await connect(target, options);
  try {
    return await run(session);
  } finally {
    await disconnect(session);
  }
}

function truncate(value: string, max = 4000): string {
  return value.length > max ? `${value.slice(0, max)}… (${value.length} octets)` : value;
}
