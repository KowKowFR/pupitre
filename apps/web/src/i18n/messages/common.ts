import type { Translated } from '@pupitre/core';

/**
 * The vocabulary all the screens share — the buttons' verbs, the waiting states,
 * the column headers that come back everywhere.
 *
 * This module is **closed**. A word only enters it if it is used as is by at
 * least three surfaces without owing anything to the context: "Save" yes, "Save
 * and continue" no — that one belongs to the assistant. A catch-all where each
 * screen drops its sentence ends up imposing on the others a wording that does
 * not suit them, and nobody dares touch it any more.
 *
 * When in doubt: the string goes into its surface's dictionary.
 */
const fr = {
  // ── Action verbs ────────────────────────────────────────────────────────
  save: 'Enregistrer',
  cancel: 'Annuler',
  close: 'Fermer',
  help: 'Aide',
  retry: 'Réessayer',
  delete: 'Supprimer',
  edit: 'Modifier',
  refresh: 'Rafraîchir',
  enable: 'Activer',
  disable: 'Désactiver',
  reset: 'Réinitialiser',
  selectAll: 'Tout sélectionner',

  // ── Waiting states. The "…" is a real U+2026 character, as everywhere.
  saving: 'Enregistrement…',
  loading: 'Chargement…',
  creating: 'Création…',
  deleting: 'Suppression…',
  checking: 'Vérification…',

  // ── Column headers ──────────────────────────────────────────────────────
  'column.date': 'Date',
  'column.state': 'État',
  'column.status': 'Statut',
  'column.target': 'Cible',
  'column.detail': 'Détail',
  'column.actions': 'Actions',
  'column.duration': 'Durée',

  // ── Pagination ──────────────────────────────────────────────────────────
  'page.previous': '← Précédente',
  'page.next': 'Suivante →',
  'page.position': 'Page {page} sur {total}',

  /**
   * The fallback of any panel `fetch` when the response has no message.
   * Twenty-eight occurrences repeated it identically; only one is left.
   */
  'http.failure': 'Échec (HTTP {status})',

  /** A missing value in a table. An em dash, not a hyphen. */
  none: '—',

  /**
   * Elapsed time, "27 min ago". Targets, deployments, probes and the log all say
   * it — see `lib/relative-time.ts`.
   */
  'ago.now': "à l'instant",
  'ago.seconds': 'il y a {count} s',
  'ago.minutes': 'il y a {count} min',
  'ago.hours': 'il y a {count} h',
  'ago.days': 'il y a {count} j',
} as const;

const en: Translated<typeof fr> = {
  save: 'Save',
  cancel: 'Cancel',
  close: 'Close',
  help: 'Help',
  retry: 'Try again',
  delete: 'Delete',
  edit: 'Edit',
  refresh: 'Refresh',
  enable: 'Enable',
  disable: 'Disable',
  reset: 'Reset',
  selectAll: 'Select all',

  saving: 'Saving…',
  loading: 'Loading…',
  creating: 'Creating…',
  deleting: 'Deleting…',
  checking: 'Checking…',

  'column.date': 'Date',
  'column.state': 'State',
  'column.status': 'Status',
  'column.target': 'Target',
  'column.detail': 'Detail',
  'column.actions': 'Actions',
  'column.duration': 'Duration',

  'page.previous': '← Previous',
  'page.next': 'Next →',
  'page.position': 'Page {page} of {total}',

  'http.failure': 'Failed (HTTP {status})',

  none: '—',

  'ago.now': 'just now',
  'ago.seconds': '{count} s ago',
  'ago.minutes': '{count} min ago',
  'ago.hours': '{count} h ago',
  'ago.days': '{count} d ago',
};

export const common = { fr, en };
