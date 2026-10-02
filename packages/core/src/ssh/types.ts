/**
 * Types de la couche SSH. Volontairement séparés du client pour que le reste
 * du monorepo puisse les importer sans tirer `ssh2` dans son graphe.
 */

export type SshAuthMethod = 'key' | 'password';
export type SudoMethod = 'nopasswd' | 'password';

export type SshCredentials =
  | { authMethod: 'key'; privateKey: string; passphrase?: string }
  | { authMethod: 'password'; password: string };

/**
 * La clé d'hôte qu'on attend de la machine — sans quoi n'importe quelle machine
 * intercalée sur le réseau pourrait se faire passer pour elle, recevoir le mot
 * de passe SSH ou sudo, voir et modifier les commandes.
 *
 * Confiance au premier contact (TOFU), comme `ssh` et son `known_hosts` :
 * `expected` vaut `null` pour une machine jamais jointe — la clé présentée est
 * acceptée, et `onFirstSeen` la reçoit pour qu'on la retienne. Ensuite, une
 * autre clé fait **refuser** la connexion, sans nouvel essai, et `onMismatch`
 * reçoit la clé présentée pour qu'on la signale.
 */
export type HostKeyPolicy = {
  /** L'empreinte retenue (`SHA256:…`), ou `null` : machine jamais jointe. */
  expected: string | null;
  onFirstSeen?: (fingerprint: string) => Promise<void> | void;
  onMismatch?: (presented: string) => Promise<void> | void;
};

/** Tout ce qu'il faut pour joindre une machine cible. */
export type SshTarget = {
  host: string;
  port: number;
  username: string;
  credentials: SshCredentials;
  sudoMethod: SudoMethod;
  /**
   * Absente : aucune vérification — réservé aux outils de test, qui visent des
   * machines jetables. Le worker la donne toujours (`sshTargetOf()`).
   */
  hostKey?: HostKeyPolicy;
};

export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
  /** `true` si la commande a été interrompue par le timeout. */
  timedOut: boolean;
  durationMs: number;
};

export type ExecOptions = {
  /** Préfixe la commande de `sudo`, selon la `sudoMethod` de la cible. */
  sudo?: boolean;
  /**
   * Millisecondes. Défaut : `DEFAULT_EXEC_TIMEOUT_MS`.
   *
   * `null` désarme la garde : la commande n'a pas de date limite et c'est
   * l'appelant qui coupe la session. Réservé au suivi de logs, qui n'a pas de
   * fin naturelle. Ne pas simuler ce cas avec un très grand nombre : au-delà
   * de 2³¹−1 ms, `setTimeout` retombe à 1 ms et coupe tout immédiatement.
   */
  timeout?: number | null;
  cwd?: string;
  /** Journalise la sortie de la commande. Coupé pour les commandes sensibles. */
  logOutput?: boolean;
};

/**
 * Journal minimal, satisfait structurellement par un logger Pino.
 * `packages/core` ne dépend d'aucun logger : l'appelant injecte le sien, avec
 * son `redact` déjà configuré.
 */
export type SshLogger = {
  debug: (obj: Record<string, unknown>, msg?: string) => void;
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
};

export type ConnectOptions = {
  /** Millisecondes pour l'établissement de la connexion. Défaut : 15 000. */
  readyTimeout?: number;
  /** Tentatives sur échec réseau. Défaut : 3. Jamais appliqué à un échec d'authentification. */
  retries?: number;
  logger?: SshLogger;
};
