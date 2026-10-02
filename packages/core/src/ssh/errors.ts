/** Erreurs de la couche SSH. Aucune ne porte de credential dans son message. */

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

/** Identifiants refusés. **Jamais** rejouée : un retry ne ferait qu'aggraver. */
export class SshAuthError extends SshError {
  override readonly name = 'SshAuthError';
}

/** Hôte injoignable, DNS, TCP, handshake. Rejouable avec backoff. */
export class SshConnectionError extends SshError {
  override readonly name = 'SshConnectionError';
}

/**
 * La machine présente une autre clé d'hôte que celle retenue. **Jamais**
 * rejouée : ce n'est pas un incident réseau — la machine a été réinstallée, ou
 * quelqu'un se fait passer pour elle. Seul un humain peut trancher.
 */
export class SshHostKeyError extends SshError {
  override readonly name = 'SshHostKeyError';

  constructor(
    host: string,
    readonly expected: string,
    readonly presented: string,
  ) {
    super(
      `La clé d'hôte de ${host} a changé : attendue ${expected}, présentée ${presented}. ` +
        'Si la machine a été réinstallée, acceptez la nouvelle clé sur la page de la cible ; ' +
        'sinon, une autre machine se fait peut-être passer pour elle — connexion refusée.',
      host,
    );
  }
}

/** Commande dépassant son délai. */
export class SshTimeoutError extends SshError {
  override readonly name = 'SshTimeoutError';
}

/** Configuration incohérente (ex. sudo par mot de passe sans mot de passe). */
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
 * Un échec d'authentification est définitif : mauvaise clé, mauvais mot de
 * passe, clé chiffrée sans passphrase. Le rejouer ne peut pas aider et, sur
 * certaines cibles, déclenche un bannissement fail2ban.
 */
export function isAuthFailure(error: unknown): boolean {
  if (error instanceof SshAuthError) return true;
  if (!(error instanceof Error)) return false;

  const level = (error as { level?: unknown }).level;
  if (level === 'client-authentication') return true;

  const message = error.message.toLowerCase();
  return AUTH_MARKERS.some((marker) => message.includes(marker));
}
