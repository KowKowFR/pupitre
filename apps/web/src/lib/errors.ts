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
 * Business errors turned into HTTP codes by the `apiRoute()` wrapper. No route
 * builds an error response by hand.
 *
 * ── Why a key rather than a sentence ────────────────────────────────────────
 * These errors are thrown from anywhere, including from synchronous code that has
 * no way of reading the instance's language. They therefore carry a
 * **reference** — a key and its variables — and it is `apiRoute()`, the only
 * place of the path that is already asynchronous, that renders the sentence in
 * the current language.
 *
 * `message` stays filled, in English, the language of the code: it is what
 * `Error.stack` sees and what Pino logs. An error therefore stays readable even
 * if nobody ever serializes it over HTTP. Whoever shows it to someone renders its
 * `ref` in their language instead (`renderRef()`).
 */

/**
 * A sentence designated by its dictionary and its key.
 *
 * The dictionary travels with the reference rather than being single and
 * central. A global error catalog would have gathered in one file sentences that
 * have nothing in common except being failures — "Target not found" belongs to
 * the targets' vocabulary, not to a catch-all. The word therefore lives next to
 * the screens that talk about the same thing, and a surface is translated from a
 * single file.
 */
export type MessageRef = {
  readonly bundle: Bundle;
  readonly key: string;
  readonly vars?: Vars;
};

/** Designates a message. The typing refuses a key absent from the given dictionary. */
export function msg<F extends Dict>(
  bundle: Bundle<F>,
  key: keyof F & string,
  vars?: Vars,
): MessageRef {
  return { bundle: bundle as Bundle, key, vars };
}

/** Renders a reference in a language. */
export function renderRef(ref: MessageRef, language: UiLanguage): string {
  return renderMessage(ref.bundle, language, ref.key, ref.vars);
}

/** Renders a reference in English — the language of `Error.message` and the logs. */
function sourceText(message: string | MessageRef): string {
  return typeof message === 'string' ? message : renderRef(message, 'en');
}

export class HttpError extends Error {
  /**
   * Present when the message comes from the catalog. Absent for the messages that
   * do not belong to the panel — those a worker, an authentication provider or a
   * third-party library returns: translating them would require translating a
   * sentence we did not write.
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

/** No valid session: 401. */
export class UnauthenticatedError extends HttpError {
  constructor(message: string | MessageRef = msg(errors, 'unauthenticated')) {
    super(401, 'unauthenticated', message);
    this.name = 'UnauthenticatedError';
  }
}

/**
 * An API token refused — malformed, unknown, revoked or expired: 401, like an
 * absent session. The code says which, so that a CI knows whether a new one must
 * be made.
 */
export class InvalidApiTokenError extends HttpError {
  constructor(reason: 'invalid' | 'revoked' | 'expired') {
    super(401, `token_${reason}`, msg(errors, `token.${reason}`));
    this.name = 'InvalidApiTokenError';
  }
}

/**
 * A valid API token, but out of its scope: a route that does not check the
 * targeted application, an application it does not cover, or a route that only
 * accepts the panel.
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

/** Valid session but missing permission: 403. */
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
 * A session without any permission — typically a public sign-up waiting for an
 * administrator to choose it a role: 403 on what is reserved to the team (chat,
 * presence), which requires no permission.
 */
export class NoAccessError extends HttpError {
  constructor(message: string | MessageRef = msg(errors, 'no_access')) {
    super(403, 'no_access', message);
    this.name = 'NoAccessError';
  }
}

/**
 * The instance's policy requires a second factor from this account, and it has
 * none: 403 everywhere, except on "My account", where it is enabled.
 */
export class TwoFactorRequiredError extends HttpError {
  constructor(message: string | MessageRef = msg(errors, 'two_factor_required')) {
    super(403, 'two_factor_required', message);
    this.name = 'TwoFactorRequiredError';
  }
}

/** A disabled account: 403, whatever the requested permission. */
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
