import type { UiLanguage } from '../i18n.js';
/**
 * Types of the SSH layer. Deliberately separate from the client so that the
 * rest of the monorepo can import them without pulling `ssh2` into its graph.
 */

export type SshAuthMethod = 'key' | 'password';
export type SudoMethod = 'nopasswd' | 'password';

export type SshCredentials =
  | { authMethod: 'key'; privateKey: string; passphrase?: string }
  | { authMethod: 'password'; password: string };

/**
 * The host key expected from the machine — otherwise any machine inserted on the
 * network could pass itself off as it, receive the SSH or sudo password, see and
 * change the commands.
 *
 * Trust on first use (TOFU), like `ssh` and its `known_hosts`: `expected` is
 * `null` for a machine never reached — the presented key is accepted, and
 * `onFirstSeen` receives it so that it is remembered. After that, another key
 * makes the connection be **refused**, without retry, and `onMismatch` receives
 * the presented key so that it is reported.
 */
export type HostKeyPolicy = {
  /** The recorded fingerprint (`SHA256:…`), or `null`: machine never reached. */
  expected: string | null;
  onFirstSeen?: (fingerprint: string) => Promise<void> | void;
  onMismatch?: (presented: string) => Promise<void> | void;
};

/** Everything needed to reach a target machine. */
export type SshTarget = {
  host: string;
  port: number;
  username: string;
  credentials: SshCredentials;
  sudoMethod: SudoMethod;
  /**
   * Absent: no check — reserved to test tools, which aim at throwaway machines.
   * The worker always provides it (`sshTargetOf()`).
   */
  hostKey?: HostKeyPolicy;
};

export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
  /** `true` if the command was interrupted by the timeout. */
  timedOut: boolean;
  durationMs: number;
};

export type ExecOptions = {
  /** Prefixes the command with `sudo`, according to the target's `sudoMethod`. */
  sudo?: boolean;
  /**
   * Milliseconds. Default: `DEFAULT_EXEC_TIMEOUT_MS`.
   *
   * `null` disarms the guard: the command has no deadline and it is the caller
   * that cuts the session. Reserved to following logs, which has no natural end.
   * Do not simulate this case with a very large number: beyond 2³¹−1 ms,
   * `setTimeout` falls back to 1 ms and cuts everything immediately.
   */
  timeout?: number | null;
  cwd?: string;
  /** Logs the command's output. Turned off for sensitive commands. */
  logOutput?: boolean;
};

/**
 * Minimal logger, structurally satisfied by a Pino logger. `packages/core`
 * depends on no logger: the caller injects its own, with its `redact` already
 * configured.
 */
export type SshLogger = {
  debug: (obj: Record<string, unknown>, msg?: string) => void;
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
};

export type ConnectOptions = {
  /** Milliseconds to establish the connection. Default: 15,000. */
  readyTimeout?: number;
  /** Attempts on network failure. Default: 3. Never applied to an authentication failure. */
  retries?: number;
  logger?: SshLogger;
  /**
   * The language of what the session will say — connection errors, timeouts. The
   * instance's.
   */
  language: UiLanguage;
};
