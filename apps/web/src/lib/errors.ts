import 'server-only';
import type { Permission } from '@pupitre/core';

/**
 * Erreurs métier traduites en codes HTTP par le wrapper `apiRoute()`.
 * Aucune route ne construit de réponse d'erreur à la main.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Aucune session valide : 401. */
export class UnauthenticatedError extends HttpError {
  constructor(message = 'Authentification requise') {
    super(401, 'unauthenticated', message);
    this.name = 'UnauthenticatedError';
  }
}

/** Session valide mais permission manquante : 403. */
export class ForbiddenError extends HttpError {
  constructor(
    readonly permission: Permission,
    message = `Permission « ${permission} » requise`,
  ) {
    super(403, 'forbidden', message, { permission });
    this.name = 'ForbiddenError';
  }
}

/** Compte désactivé : 403, quelle que soit la permission demandée. */
export class AccountDisabledError extends HttpError {
  constructor(message = 'Compte désactivé') {
    super(403, 'account_disabled', message);
    this.name = 'AccountDisabledError';
  }
}

export class NotFoundError extends HttpError {
  constructor(message = 'Ressource introuvable') {
    super(404, 'not_found', message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, 'conflict', message);
    this.name = 'ConflictError';
  }
}

export class NotImplementedError extends HttpError {
  constructor(message: string) {
    super(501, 'not_implemented', message);
    this.name = 'NotImplementedError';
  }
}
