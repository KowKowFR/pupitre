import type { Translated } from '@pupitre/core';

/**
 * The API's error messages.
 *
 * ── Why they are translated, when a script reads them too ───────────────────
 * An error response carries two things: a `code` — stable, for machines, never
 * translated — and a `message` — prose, written for a human. The panel shows this
 * `message` as is in its banners and toasts. Leaving it in French would produce
 * exactly the bug we refuse: an English screen where the failure speaks French.
 *
 * A script, for its part, must hang on to the `code`. That is what the contract
 * says, and it is what the checks that matter already do. Those that look for
 * prose keep passing as long as the instance is in French, because **the `fr`
 * column reproduces word for word the strings from before** — not a comma moved.
 * This rule holds for this whole file.
 *
 * ── Where the language is decided ───────────────────────────────────────────
 * In `apiRoute()`, at serialization time, and nowhere else. Errors are thrown
 * from everywhere, including from synchronous code: they cannot go and read the
 * instance settings themselves. So they carry a key and its variables (`msg()`),
 * and the only place that already knows how to be asynchronous renders the
 * sentence.
 *
 * `error.message`, for its part, stays in French, the dictionaries' source
 * language: it is what Pino logs.
 */
const fr = {
  'invalid_json': 'Corps de requête JSON invalide',
  'cross_site':
    'Requête refusée : elle ne vient pas du panel. Si vous utilisez le panel par une autre adresse que BETTER_AUTH_URL, corrigez cette variable.',
  'invalid_form': 'Formulaire illisible',
  'payload_too_large': 'Envoi trop volumineux : {max} octets au plus',
  'validation.schema': 'La requête ne respecte pas le schéma',
  'validation.body': 'Le corps de la requête ne respecte pas le schéma',
  'internal': 'Erreur interne',
  'unauthenticated': 'Authentification requise',
  'forbidden': 'Permission « {permission} » requise',
  'account_disabled': 'Compte désactivé',
  'no_access': 'Votre compte n’a encore accès à rien : un administrateur doit vous attribuer un rôle',
  'two_factor_required':
    'Votre rôle exige un second facteur : connectez-vous au panel pour l’activer',
  'two_factor_locked': 'Votre rôle exige un second facteur : il ne se désactive pas',
  'token.invalid': 'Jeton d’API invalide',
  'token.revoked': 'Ce jeton d’API a été révoqué',
  'token.expired': 'Ce jeton d’API est échu',
  'token.scope': 'Ce jeton d’API est limité à certaines applications : cette route ne l’accepte pas',
  'token.application': 'Ce jeton d’API ne couvre pas cette application',
  'token.sessionOnly': 'Cette route n’accepte pas de jeton d’API : elle se fait depuis le panel',
  'not_found': 'Ressource introuvable',
  /**
   * Two keys rather than a variable: French chose between "fenêtre" and "période"
   * through a ternary in the middle of the template. A word variable does not
   * translate — it imposes the source language's syntax on the translator.
   */
  'rate_limited.window': 'Trop de requêtes : {limit} par fenêtre. Réessayez dans {seconds} s.',
  'rate_limited.period': 'Trop de requêtes : {limit} par période. Réessayez dans {seconds} s.',
} as const;

const en: Translated<typeof fr> = {
  'invalid_json': 'Malformed JSON request body',
  'cross_site':
    'Request refused: it does not come from the panel. If you reach the panel by another address than BETTER_AUTH_URL, fix that variable.',
  'invalid_form': 'Unreadable form',
  'payload_too_large': 'Upload too large: {max} bytes at most',
  'validation.schema': 'The request does not match the schema',
  'validation.body': 'The request body does not match the schema',
  'internal': 'Internal error',
  'unauthenticated': 'Authentication required',
  'forbidden': 'Permission “{permission}” required',
  'account_disabled': 'Account disabled',
  'no_access': 'Your account has no access yet: an administrator has to assign you a role',
  'two_factor_required': 'Your role requires a second factor: sign in to the panel to turn it on',
  'two_factor_locked': 'Your role requires a second factor: it cannot be turned off',
  'token.invalid': 'Invalid API token',
  'token.revoked': 'This API token was revoked',
  'token.expired': 'This API token has expired',
  'token.scope': 'This API token is limited to some applications: this route does not accept it',
  'token.application': 'This API token does not cover this application',
  'token.sessionOnly': 'This route does not accept API tokens: it is done from the panel',
  'not_found': 'Resource not found',
  'rate_limited.window': 'Too many requests: {limit} per window. Try again in {seconds} s.',
  'rate_limited.period': 'Too many requests: {limit} per period. Try again in {seconds} s.',
};

export const errors = { fr, en };
export type ErrorKey = keyof typeof fr;
