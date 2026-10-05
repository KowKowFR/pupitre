import type { UiLanguage } from '../i18n.js';
import { sshSay } from './messages.js';

/** Errors of the SSH layer. None carries a credential in its message. */

export class SshError extends Error {
  constructor(
    message: string,
    readonly host: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SshError';
  }
}

/** Credentials refused. **Never** retried: a retry would only make things worse. */
export class SshAuthError extends SshError {
  override readonly name = 'SshAuthError';
}

/** Host unreachable, DNS, TCP, handshake. Retryable with backoff. */
export class SshConnectionError extends SshError {
  override readonly name = 'SshConnectionError';
}

/**
 * The machine presents a different host key from the recorded one. **Never**
 * retried: it is not a network incident — the machine was reinstalled, or
 * someone is passing themselves off as it. Only a human can decide.
 */
export class SshHostKeyError extends SshError {
  override readonly name = 'SshHostKeyError';

  constructor(
    host: string,
    readonly expected: string,
    readonly presented: string,
    language: UiLanguage,
  ) {
    super(sshSay(language)('hostKey.changed', { host, expected, presented }), host);
  }
}

/** Command exceeding its timeout. */
export class SshTimeoutError extends SshError {
  override readonly name = 'SshTimeoutError';
}

/** Inconsistent configuration (e.g. password sudo without a password). */
export class SshConfigError extends SshError {
  override readonly name = 'SshConfigError';
}

const AUTH_MARKERS = [
  'all configured authentication methods failed',
  'authentication failed',
  'permission denied',
  'no matching authentication',
  'cannot parse privatekey',
  'unsupported key format',
  'encrypted openssh private key detected',
  'bad passphrase',
  'invalid passphrase',
];

/**
 * An authentication failure is final: wrong key, wrong password, encrypted key
 * without a passphrase. Retrying cannot help and, on some targets, triggers a
 * fail2ban ban.
 */
export function isAuthFailure(error: unknown): boolean {
  if (error instanceof SshAuthError) return true;
  if (!(error instanceof Error)) return false;

  const level = (error as { level?: unknown }).level;
  if (level === 'client-authentication') return true;

  const message = error.message.toLowerCase();
  return AUTH_MARKERS.some((marker) => message.includes(marker));
}
