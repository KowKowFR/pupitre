import type { Translated } from '@pupitre/core';

/**
 * Les messages d'erreur de l'API.
 *
 * ── Pourquoi ils sont traduits, alors qu'un script les lit aussi ────────────
 * Une réponse d'erreur porte deux choses : un `code` — stable, machine, jamais
 * traduit — et un `message` — de la prose, écrite pour un humain. Le panel
 * affiche ce `message` tel quel dans ses bandeaux et ses toasts. Le laisser en
 * français produirait exactement le défaut qu'on refuse : un écran anglais où
 * l'échec parle français.
 *
 * Un script, lui, doit s'accrocher au `code`. C'est ce que dit le contrat, et
 * c'est ce que font déjà les vérifications qui comptent. Celles qui cherchent
 * de la prose continuent de passer tant que l'instance est en français, parce
 * que **la colonne `fr` reproduit mot pour mot les chaînes d'avant** — pas une
 * virgule déplacée. Cette règle vaut pour tout ce fichier.
 *
 * ── Où la langue est décidée ────────────────────────────────────────────────
 * Dans `apiRoute()`, au moment de sérialiser, et nulle part ailleurs. Les
 * erreurs se lancent de partout, y compris de code synchrone : elles ne
 * peuvent pas aller lire les paramètres d'instance elles-mêmes. Elles
 * transportent donc une clé et ses variables (`msg()`), et le seul endroit qui
 * sait déjà être asynchrone rend la phrase.
 *
 * `error.message`, lui, reste français : c'est ce que Pino journalise, et les
 * logs sont dans la langue du projet.
 */
const fr = {
  'invalid_json': 'Corps de requête JSON invalide',
  'invalid_form': 'Formulaire illisible',
  'payload_too_large': 'Envoi trop volumineux : {max} octets au plus',
  'validation.schema': 'La requête ne respecte pas le schéma',
  'validation.body': 'Le corps de la requête ne respecte pas le schéma',
  'internal': 'Erreur interne',
  'unauthenticated': 'Authentification requise',
  'forbidden': 'Permission « {permission} » requise',
  'account_disabled': 'Compte désactivé',
  'not_found': 'Ressource introuvable',
  /**
   * Deux clés plutôt qu'une variable : le français choisissait entre
   * « fenêtre » et « période » par un ternaire au milieu du gabarit. Une
   * variable de mot ne se traduit pas — elle impose au traducteur la syntaxe
   * de la langue source.
   */
  'rate_limited.window': 'Trop de requêtes : {limit} par fenêtre. Réessayez dans {seconds} s.',
  'rate_limited.period': 'Trop de requêtes : {limit} par période. Réessayez dans {seconds} s.',
} as const;

const en: Translated<typeof fr> = {
  'invalid_json': 'Malformed JSON request body',
  'invalid_form': 'Unreadable form',
  'payload_too_large': 'Upload too large: {max} bytes at most',
  'validation.schema': 'The request does not match the schema',
  'validation.body': 'The request body does not match the schema',
  'internal': 'Internal error',
  'unauthenticated': 'Authentication required',
  'forbidden': 'Permission “{permission}” required',
  'account_disabled': 'Account disabled',
  'not_found': 'Resource not found',
  'rate_limited.window': 'Too many requests: {limit} per window. Try again in {seconds} s.',
  'rate_limited.period': 'Too many requests: {limit} per period. Try again in {seconds} s.',
};

export const errors = { fr, en };
export type ErrorKey = keyof typeof fr;
