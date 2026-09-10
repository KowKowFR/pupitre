import { randomUUID } from 'node:crypto';
import { NodeSSH } from 'node-ssh';
import {
  SshConfigError,
  SshConnectionError,
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

  const base = {
    host: target.host,
    port: target.port,
    username: target.username,
    readyTimeout,
    keepaliveInterval: 10_000,
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

    try {
      await client.connect(config);
      const latencyMs = Date.now() - startedAt;

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
        client,
        target,
        logger: options.logger,
      };
    } catch (error) {
      lastError = error;
      client.dispose();

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

/** Échappement POSIX en quotes simples. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
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
 * Servira au jalon 4 pour pousser les logs de déploiement sur Redis pub/sub.
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
