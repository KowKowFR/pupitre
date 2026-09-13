import type { UiLanguage } from '../i18n.js';
import type { ChannelConfig, NotificationChannelKind } from './catalog.js';
import type { NotificationDigest } from './digest.js';
import type { NotificationMessage } from './message.js';

/**
 * Contrat que doit remplir un moyen de prévenir quelqu'un.
 *
 * Même règle structurante que pour les drivers et les scanners : une
 * implémentation **n'importe rien** de `packages/db`, ni de `apps/web`, ni de
 * Redis. Elle reçoit une configuration déjà validée, un message neutre, et elle
 * délivre. C'est l'appelant qui décide d'enregistrer le résultat ou de le jeter.
 *
 * Ajouter un canal doit se faire en ajoutant une classe et une entrée dans la
 * fabrique, sans toucher au worker, aux routes ni à l'écran.
 */

/**
 * Configuration résolue d'un canal : la partie publique lue en base, la partie
 * secrète déchiffrée juste avant l'appel. Les deux sont séparées jusqu'ici
 * — c'est ce qui garantit qu'aucune couche intermédiaire ne manipule un secret
 * par mégarde.
 */
export type ResolvedChannelConfig = {
  config: ChannelConfig;
  secrets: ChannelConfig;
};

export type NotificationTestResult = {
  ok: boolean;
  /** Une phrase, affichable telle quelle. Déjà expurgée de tout secret. */
  detail: string;
};

export interface NotificationChannel {
  readonly kind: NotificationChannelKind;

  /**
   * Vérifie que la configuration fonctionne **sans délivrer** de message
   * visible, quand le protocole propose une telle sonde (poignée de main SMTP,
   * `getMe` Telegram, lecture du webhook Discord).
   *
   * Un canal qui n'en propose aucune le dit — il ne prétend pas avoir vérifié.
   *
   * La langue est passée ici, alors que `send()` et `sendDigest()` la lisent sur
   * la charge qu'ils délivrent : une sonde ne transporte aucun message, et son
   * verdict s'affiche pourtant dans le panel. C'est l'appelant qui la résout,
   * `packages/core` ne lisant jamais les paramètres d'instance.
   */
  test(resolved: ResolvedChannelConfig, language?: UiLanguage): Promise<NotificationTestResult>;

  /** Délivre une alerte unitaire. Lève une `NotificationError` en cas d'échec. */
  send(resolved: ResolvedChannelConfig, message: NotificationMessage): Promise<void>;

  /**
   * Délivre un **résumé** — plusieurs événements du même type, retenus pendant
   * une fenêtre de regroupement.
   *
   * Méthode distincte et **obligatoire**, pas un drapeau sur `send()` : un
   * résumé porte une liste, une fenêtre et un total, et chaque protocole les
   * rend différemment. Un e-mail peut lister cent lignes, un message Telegram
   * doit tenir à l'écran. Faire entrer tout cela dans un `NotificationMessage`
   * obligerait chaque canal à deviner qu'un texte cache une liste — c'est la
   * fuite d'abstraction que cette couche interdit.
   *
   * Obligatoire pour que le compilateur refuse un canal qui saurait alerter
   * mais pas résumer : il enverrait alors cinquante messages là où les autres
   * en envoient un.
   */
  sendDigest(resolved: ResolvedChannelConfig, digest: NotificationDigest): Promise<void>;
}

/** Échec imputable à un canal, avec le contexte utile au diagnostic. */
export class NotificationError extends Error {
  constructor(
    message: string,
    readonly channel: NotificationChannelKind,
    readonly phase: 'config' | 'connect' | 'send',
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'NotificationError';
  }
}

// ─── transports injectables ───────────────────────────────────────────────────

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Ce qu'un envoi SMTP demande, réduit à l'essentiel. */
export type SmtpEnvelope = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
};

export type SmtpOptions = {
  host: string;
  port: number;
  /** `true` = SMTPS implicite (la session s'ouvre déjà chiffrée). */
  secure: boolean;
  requireTls: boolean;
  rejectUnauthorized: boolean;
  auth: { user: string; pass: string } | null;
  timeoutMs: number;
};

/**
 * Le transport SMTP, vu comme deux fonctions. C'est ce qui rend la couche
 * vérifiable sans serveur : un test fournit un faux qui enregistre l'enveloppe
 * et rend la main, sans ouvrir de socket.
 */
export type SmtpTransport = {
  verify: () => Promise<void>;
  send: (envelope: SmtpEnvelope) => Promise<void>;
  close: () => void;
};

export type SmtpTransportFactory = (options: SmtpOptions) => SmtpTransport;

export type NotificationTransports = {
  fetch: FetchLike;
  smtp: SmtpTransportFactory;
  /** Borne haute d'un appel réseau. Le worker la fixe, les canaux l'appliquent. */
  timeoutMs: number;
};

// ─── expurgation ──────────────────────────────────────────────────────────────

/**
 * Formes que prennent les jetons chez les fournisseurs visés, y compris
 * **masquées** par eux.
 *
 * Constaté ailleurs dans ce dépôt (`@pupitre/core/ai`) : sur une clé refusée, un
 * fournisseur renvoie « Incorrect API key provided: sk-abcd1234***…***wxyz » —
 * soit une partie de la clé, en clair, dans un message que nous relayons
 * ensuite dans une réponse HTTP et dans le journal d'audit. Le masque du
 * fournisseur n'est pas notre masque.
 *
 * Ici : le jeton de bot Telegram (`123456789:AA…`), qui apparaît tel quel dans
 * l'URL que le client HTTP recopie dans ses messages d'erreur, et le jeton
 * terminal d'une URL de webhook Discord.
 */
const TOKEN_LIKE: readonly RegExp[] = [
  // Jeton de bot Telegram, y compris quand il est encore dans l'URL.
  /\b\d{6,12}:[A-Za-z0-9_-]{20,}/g,
  // Jeton d'un webhook Discord — dernier segment, après l'identifiant.
  /(\/api\/webhooks\/\d+\/)[A-Za-z0-9_.-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

/**
 * Retire d'un message tout ce qui ressemble à un secret, avant qu'il n'atteigne
 * une réponse, un log, le journal d'audit ou la colonne `last_error`.
 *
 * Deux passes, dans cet ordre : les valeurs exactes que l'on connaît — la seule
 * garantie réelle —, puis les formes reconnaissables, qui rattrapent les
 * variantes tronquées ou reformatées par le service distant.
 */
export function redactSecrets(text: string, secrets: ChannelConfig = {}): string {
  let result = text;

  for (const value of Object.values(secrets)) {
    const secret = typeof value === 'string' ? value.trim() : '';
    if (secret.length < 6) continue;
    result = result.split(secret).join('[secret masqué]');
    // Une URL de webhook Discord traverse aussi les messages tronquée à son
    // jeton : on masque donc aussi ce qui suit le dernier `/`.
    const tail = secret.slice(secret.lastIndexOf('/') + 1);
    if (tail.length >= 10 && tail !== secret) result = result.split(tail).join('[secret masqué]');
  }

  for (const pattern of TOKEN_LIKE) {
    result = result.replace(pattern, (_match: string, prefix: string | undefined) =>
      prefix ? `${prefix}[secret masqué]` : '[secret masqué]',
    );
  }

  return result;
}

/**
 * Message d'une erreur quelconque, tronqué et expurgé.
 *
 * La cause est dépliée d'un cran, et ce n'est pas du confort : `fetch` remonte
 * « fetch failed » pour *toutes* les pannes de transport — DNS muet, connexion
 * refusée, TLS rejeté, délai dépassé —, et range la vraie raison dans `cause`.
 * Un `last_error` qui dit « fetch failed » ne rend pas l'échec visible, il le
 * rend seulement mentionné.
 */
export function describeFailure(error: unknown, secrets: ChannelConfig = {}): string {
  let raw = error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);

  const cause: unknown = error instanceof Error ? error.cause : undefined;
  if (cause instanceof Error && cause.message.length > 0 && !raw.includes(cause.message)) {
    raw = `${raw} : ${cause.message}`;
  } else if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    raw = `${raw} : ${String((cause as { code: unknown }).code)}`;
  }

  return redactSecrets(raw, secrets).slice(0, 400);
}

// ─── ce qu'un envoi transporte ────────────────────────────────────────────────

/**
 * La charge d'une distribution : une alerte unitaire, ou un résumé.
 *
 * Le discriminant vit ici plutôt que dans le worker : c'est la couche des
 * canaux qui connaît les deux formes, et c'est elle qui doit rester le seul
 * endroit où l'on choisit entre `send()` et `sendDigest()`.
 */
export type NotificationPayload =
  | { readonly type: 'event'; readonly message: NotificationMessage }
  | { readonly type: 'digest'; readonly digest: NotificationDigest };

/** Le **seul** aiguillage entre alerte unitaire et résumé, dans tout le projet. */
export function deliverNotification(
  channel: NotificationChannel,
  resolved: ResolvedChannelConfig,
  payload: NotificationPayload,
): Promise<void> {
  return payload.type === 'digest'
    ? channel.sendDigest(resolved, payload.digest)
    : channel.send(resolved, payload.message);
}

/** L'événement porté par une charge, quel que soit son type — pour les en-têtes et les logs. */
export function notificationPayloadEvent(payload: NotificationPayload): string {
  return payload.type === 'digest' ? payload.digest.event : payload.message.event;
}
