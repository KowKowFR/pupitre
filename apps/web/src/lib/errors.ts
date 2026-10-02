import 'server-only';
import {
  renderMessage,
  type Bundle,
  type Dict,
  type Permission,
  type UiLanguage,
  type Vars,
} from '@pupitre/core';
import { errors } from '@/i18n/messages/errors';

/**
 * Erreurs métier traduites en codes HTTP par le wrapper `apiRoute()`.
 * Aucune route ne construit de réponse d'erreur à la main.
 *
 * ── Pourquoi une clé plutôt qu'une phrase ───────────────────────────────────
 * Ces erreurs se lancent depuis n'importe où, y compris depuis du code
 * synchrone qui n'a aucun moyen d'aller lire la langue de l'instance. Elles
 * transportent donc une **référence** — une clé et ses variables — et c'est
 * `apiRoute()`, seul endroit déjà asynchrone du chemin, qui rend la phrase dans
 * la langue courante.
 *
 * `message` reste rempli, en français : c'est ce que voit `Error.stack`, ce que
 * Pino journalise, et ce que lisent les rares appelants internes qui attrapent
 * l'erreur pour la réémettre. Une erreur reste donc lisible même si personne ne
 * la sérialise jamais en HTTP.
 */

/**
 * Une phrase désignée par son dictionnaire et sa clé.
 *
 * Le dictionnaire voyage avec la référence plutôt que d'être unique et
 * central. Un catalogue d'erreurs global aurait rassemblé en un fichier des
 * phrases qui n'ont rien en commun sinon d'être des échecs — « Cible
 * introuvable » appartient au vocabulaire des cibles, pas à un fourre-tout. Le
 * mot vit donc à côté des écrans qui parlent de la même chose, et une surface
 * se traduit d'un seul fichier.
 */
export type MessageRef = {
  readonly bundle: Bundle;
  readonly key: string;
  readonly vars?: Vars;
};

/** Désigne un message. Le typage refuse une clé absente du dictionnaire donné. */
export function msg<F extends Dict>(
  bundle: Bundle<F>,
  key: keyof F & string,
  vars?: Vars,
): MessageRef {
  return { bundle: bundle as Bundle, key, vars };
}

/** Rend une référence dans une langue. */
export function renderRef(ref: MessageRef, language: UiLanguage): string {
  return renderMessage(ref.bundle, language, ref.key, ref.vars);
}

/** Rend une référence en français — la langue des logs et de `Error.message`. */
function sourceText(message: string | MessageRef): string {
  return typeof message === 'string' ? message : renderRef(message, 'fr');
}

export class HttpError extends Error {
  /**
   * Présente quand le message vient du catalogue. Absente pour les messages
   * qui n'appartiennent pas au panel — ceux que renvoie un worker, un
   * fournisseur d'authentification ou une bibliothèque tierce : les traduire
   * demanderait de traduire une phrase qu'on n'a pas écrite.
   */
  readonly ref?: MessageRef;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string | MessageRef,
    readonly details?: unknown,
  ) {
    super(sourceText(message));
    this.name = 'HttpError';
    if (typeof message !== 'string') this.ref = message;
  }
}

/** Aucune session valide : 401. */
export class UnauthenticatedError extends HttpError {
  constructor(message: string | MessageRef = msg(errors, 'unauthenticated')) {
    super(401, 'unauthenticated', message);
    this.name = 'UnauthenticatedError';
  }
}

/**
 * Jeton d'API refusé — mal formé, inconnu, révoqué ou échu : 401, comme une
 * session absente. Le code dit lequel, pour qu'une CI sache s'il faut en
 * refaire un.
 */
export class InvalidApiTokenError extends HttpError {
  constructor(reason: 'invalid' | 'revoked' | 'expired') {
    super(401, `token_${reason}`, msg(errors, `token.${reason}`));
    this.name = 'InvalidApiTokenError';
  }
}

/**
 * Jeton d'API valide, mais hors de sa portée : une route qui ne vérifie pas
 * l'application visée, une application qu'il ne couvre pas, ou une route qui
 * n'accepte que le panel.
 */
export class ApiTokenScopeError extends HttpError {
  constructor(reason: 'scope' | 'application' | 'sessionOnly') {
    super(
      403,
      reason === 'sessionOnly' ? 'token_refused' : 'token_scope',
      msg(errors, `token.${reason}`),
    );
    this.name = 'ApiTokenScopeError';
  }
}

/** Session valide mais permission manquante : 403. */
export class ForbiddenError extends HttpError {
  constructor(
    readonly permission: Permission,
    message: string | MessageRef = msg(errors, 'forbidden', { permission }),
  ) {
    super(403, 'forbidden', message, { permission });
    this.name = 'ForbiddenError';
  }
}

/**
 * Session sans aucune permission — typiquement une inscription publique qui
 * attend qu'un administrateur lui choisisse un rôle : 403 sur ce qui est
 * réservé à l'équipe (discussion, présence), qui ne demande pas de permission.
 */
export class NoAccessError extends HttpError {
  constructor(message: string | MessageRef = msg(errors, 'no_access')) {
    super(403, 'no_access', message);
    this.name = 'NoAccessError';
  }
}

/**
 * La politique de l'instance exige un second facteur de ce compte, et il n'en
 * a pas : 403 partout, sauf sur « Mon compte », où il s'active.
 */
export class TwoFactorRequiredError extends HttpError {
  constructor(message: string | MessageRef = msg(errors, 'two_factor_required')) {
    super(403, 'two_factor_required', message);
    this.name = 'TwoFactorRequiredError';
  }
}

/** Compte désactivé : 403, quelle que soit la permission demandée. */
export class AccountDisabledError extends HttpError {
  constructor(message: string | MessageRef = msg(errors, 'account_disabled')) {
    super(403, 'account_disabled', message);
    this.name = 'AccountDisabledError';
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string | MessageRef = msg(errors, 'not_found')) {
    super(404, 'not_found', message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends HttpError {
  constructor(message: string | MessageRef) {
    super(409, 'conflict', message);
    this.name = 'ConflictError';
  }
}

export class NotImplementedError extends HttpError {
  constructor(message: string | MessageRef) {
    super(501, 'not_implemented', message);
    this.name = 'NotImplementedError';
  }
}
