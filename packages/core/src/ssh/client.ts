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

export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
export const DEFAULT_READY_TIMEOUT_MS = 15_000;
export const DEFAULT_RETRIES = 3;

/** Session ouverte. Opaque pour l'appelant : tout passe par les fonctions du module. */
export type SshSession = {
  readonly id: string;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly connectedAt: Date;
  /** Temps d'établissement de la connexion, en millisecondes. */
  readonly latencyMs: number;
  /** L'empreinte de la clé d'hôte présentée (`SHA256:…`). */
  readonly hostKey: string | null;
  /** @internal */
  readonly client: NodeSSH;
  /** @internal */
  readonly target: SshTarget;
  /** @internal */
  readonly logger: SshLogger | undefined;
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
 * L'empreinte d'une clé d'hôte, au format de `ssh-keygen -lf` :
 * `SHA256:` puis le SHA-256 du blob de la clé publique, en base64 sans `=`.
 */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/**
 * Ouvre une session SSH.
 *
 * Rejoue jusqu'à `retries` fois avec un backoff exponentiel sur échec réseau.
 * **Jamais** sur échec d'authentification : la clé ne deviendra pas valide en
 * réessayant, et certaines cibles bannissent l'IP après quelques tentatives.
 */
export async function connect(
  target: SshTarget,
  options: ConnectOptions = {},
): Promise<SshSession> {
  const logger = options.logger ?? noopLogger;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const readyTimeout = options.readyTimeout ?? DEFAULT_READY_TIMEOUT_MS;

  // La clé présentée, relevée à chaque tentative ; refusée si elle n'est pas
  // celle qu'on attend — `ssh2` coupe alors la poignée de main.
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

      // Une machine jamais jointe : sa clé est retenue, désormais attendue.
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
      };
    } catch (error) {
      lastError = error;
      client.dispose();

      // `presented` est réassigné par le vérificateur, appelé pendant `connect`.
      const seen = presented as string | null;
      if (policy?.expected && seen && seen !== policy.expected) {
        logger.warn(
          { host: target.host, expected: policy.expected, presented: seen },
          "clé d'hôte inattendue — connexion refusée, aucune nouvelle tentative",
        );
        await policy.onMismatch?.(seen);
        throw new SshHostKeyError(target.host, policy.expected, seen);
      }

      if (isAuthFailure(error)) {
        logger.warn(
          { host: target.host, authMethod: target.credentials.authMethod },
          "échec d'authentification SSH — aucune nouvelle tentative",
        );
        throw new SshAuthError(
          "Authentification SSH refusée (clé ou mot de passe invalide, ou passphrase manquante)",
          target.host,
          error,
        );
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
    `Connexion SSH impossible vers ${target.host}:${target.port} après ${retries} tentatives`,
    target.host,
    lastError,
  );
}

/**
 * Enrobe une commande de `sudo` selon la méthode déclarée sur la cible.
 * `nopasswd` → `sudo -n` ; `password` → `sudo -S` alimenté par stdin.
 */
function withSudo(session: SshSession, command: string): { command: string; stdin?: string } {
  if (session.target.sudoMethod === 'nopasswd') {
    return { command: `sudo -n -- sh -c ${shellQuote(command)}` };
  }

  if (session.target.credentials.authMethod !== 'password') {
    throw new SshConfigError(
      "sudo_method « password » exige une authentification par mot de passe : " +
        "aucun mot de passe disponible pour cette cible en authentification par clé",
      session.host,
    );
  }

  // Le mot de passe passe par stdin, jamais par la ligne de commande :
  // il n'apparaît donc ni dans `ps`, ni dans l'historique du shell distant.
  return {
    command: `sudo -S -p '' -- sh -c ${shellQuote(command)}`,
    stdin: `${session.target.credentials.password}\n`,
  };
}

/**
 * Exécute une commande et retourne son résultat complet.
 * Un code de retour non nul n'est pas une erreur : c'est une information que
 * l'appelant interprète (un `docker` absent renvoie 127, ce n'est pas un échec
 * du preflight).
 */
export async function exec(
  session: SshSession,
  command: string,
  options: ExecOptions = {},
): Promise<ExecResult> {
  const logger = session.logger ?? noopLogger;
  // `??` confondrait `null` — garde désarmée, volontaire — avec « non fourni ».
  const timeout = options.timeout === undefined ? DEFAULT_EXEC_TIMEOUT_MS : options.timeout;
  const prepared = options.sudo ? withSudo(session, command) : { command };
  const startedAt = Date.now();

  logger.debug(
    { host: session.host, sessionId: session.id, command, sudo: options.sudo === true, timeout },
    'exécution SSH',
  );

  const run = session.client.execCommand(prepared.command, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(prepared.stdin ? { stdin: prepared.stdin } : {}),
  });

  let timer: NodeJS.Timeout | undefined;
  // `timeout: null` : aucune garde. On ne met alors rien dans la course, sinon
  // la promesse resterait en suspens à jamais.
  const guard =
    timeout === null
      ? null
      : new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new SshTimeoutError(`Commande interrompue après ${timeout} ms`, session.host));
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
      // La sortie traverse le `redact` Pino configuré par l'appelant.
      logger.debug(
        {
          host: session.host,
          command,
          code: result.code,
          durationMs: result.durationMs,
          stdout: truncate(result.stdout),
          stderr: truncate(result.stderr),
        },
        'commande SSH terminée',
      );
    } else {
      logger.debug(
        { host: session.host, code: result.code, durationMs: result.durationMs },
        'commande SSH terminée (sortie non journalisée)',
      );
    }

    return result;
  } catch (error) {
    if (error instanceof SshTimeoutError) {
      logger.warn({ host: session.host, command, timeout }, 'commande SSH en timeout');
      return {
        code: -1,
        stdout: '',
        stderr: `timeout après ${timeout} ms`,
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
 * Exécute une commande en diffusant sa sortie ligne par ligne.
 * Sert à pousser les logs de déploiement sur Redis pub/sub.
 */
export async function execStream(
  session: SshSession,
  command: string,
  onLine: (line: string, stream: 'stdout' | 'stderr') => void,
  options: ExecOptions = {},
): Promise<ExecResult> {
  const logger = session.logger ?? noopLogger;
  // `??` confondrait `null` — garde désarmée, volontaire — avec « non fourni ».
  const timeout = options.timeout === undefined ? DEFAULT_EXEC_TIMEOUT_MS : options.timeout;
  const prepared = options.sudo ? withSudo(session, command) : { command };
  const startedAt = Date.now();

  logger.debug(
    { host: session.host, sessionId: session.id, command, sudo: options.sudo === true },
    'exécution SSH en flux',
  );

  /** Découpe un flux d'octets en lignes complètes. */
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
  // `timeout: null` : aucune garde. On ne met alors rien dans la course, sinon
  // la promesse resterait en suspens à jamais.
  const guard =
    timeout === null
      ? null
      : new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new SshTimeoutError(`Commande interrompue après ${timeout} ms`, session.host));
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
        stderr: `timeout après ${timeout} ms`,
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
  /** Reçoit la sortie standard brute — octets, pas lignes. Terminé à la fin de la commande. */
  stdout?: Writable;
  /** Alimente l'entrée standard ; sa fin ferme l'entrée de la commande distante. */
  stdin?: Readable;
  /** Millisecondes. `null` : aucune garde. Défaut : six heures. */
  timeout?: number | null;
};

export type PipeResult = {
  code: number;
  /** Les derniers kilo-octets de la sortie d'erreur, pour dire pourquoi. */
  stderr: string;
  timedOut: boolean;
  durationMs: number;
};

const PIPE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const STDERR_TAIL_BYTES = 8 * 1024;

/**
 * Exécute une commande en branchant ses flux **octets** — une archive de
 * volume qui sort, un export de base qui rentre. `exec()` et `execStream()`
 * accumulent ou découpent du texte : un `tar` de plusieurs gigaoctets n'y a pas
 * sa place.
 *
 * La pression arrière est respectée dans les deux sens : un envoi lent vers le
 * stockage ralentit la lecture sur la cible au lieu de tout garder en mémoire.
 * Pas de `sudo` ici : les commandes qui passent par là (`docker`, `kubectl`)
 * tournent sous l'utilisateur de la cible, comme le reste des drivers.
 */
export async function execPipe(
  session: SshSession,
  command: string,
  options: PipeOptions = {},
): Promise<PipeResult> {
  const logger = session.logger ?? noopLogger;
  const connection = session.client.connection;
  if (!connection) {
    throw new SshConnectionError('Session SSH fermée', session.host, undefined);
  }
  const timeout = options.timeout === undefined ? PIPE_TIMEOUT_MS : options.timeout;
  const startedAt = Date.now();
  logger.debug({ host: session.host, sessionId: session.id, command }, 'exécution SSH en tube');

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

/** Téléverse un fichier local ou un contenu en mémoire vers la cible. */
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
    'fichier téléversé',
  );
}

export async function disconnect(session: SshSession): Promise<void> {
  session.client.dispose();
  (session.logger ?? noopLogger).debug(
    { host: session.host, sessionId: session.id },
    'session SSH fermée',
  );
}

/** Ouvre une session, exécute `run`, puis ferme quoi qu'il arrive. */
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
