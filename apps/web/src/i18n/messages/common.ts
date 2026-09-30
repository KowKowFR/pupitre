import type { Translated } from '@pupitre/core';

/**
 * Le vocabulaire que tous les écrans partagent — les verbes des boutons, les
 * états d'attente, les en-têtes de colonne qui reviennent partout.
 *
 * Ce module est **fermé**. Un mot n'y entre que s'il est employé tel quel par
 * au moins trois surfaces sans rien devoir au contexte : « Enregistrer » oui,
 * « Enregistrer et continuer » non — celui-là appartient à l'assistant. Un
 * fourre-tout où chaque écran dépose sa phrase finit par imposer aux autres une
 * formulation qui ne leur va pas, et personne n'ose plus y toucher.
 *
 * En cas de doute : la chaîne va dans le dictionnaire de sa surface.
 */
const fr = {
  // ── Verbes d'action ─────────────────────────────────────────────────────
  save: 'Enregistrer',
  cancel: 'Annuler',
  close: 'Fermer',
  retry: 'Réessayer',
  delete: 'Supprimer',
  edit: 'Modifier',
  refresh: 'Rafraîchir',
  enable: 'Activer',
  disable: 'Désactiver',
  reset: 'Réinitialiser',
  selectAll: 'Tout sélectionner',

  // ── États d'attente. Le « … » est un vrai caractère U+2026, comme partout.
  saving: 'Enregistrement…',
  loading: 'Chargement…',
  creating: 'Création…',
  deleting: 'Suppression…',
  checking: 'Vérification…',

  // ── En-têtes de colonne ─────────────────────────────────────────────────
  'column.date': 'Date',
  'column.name': 'Nom',
  'column.state': 'État',
  'column.status': 'Statut',
  'column.type': 'Type',
  'column.target': 'Cible',
  'column.detail': 'Détail',
  'column.actions': 'Actions',
  'column.duration': 'Durée',

  // ── Pagination ──────────────────────────────────────────────────────────
  'page.previous': '← Précédente',
  'page.next': 'Suivante →',
  'page.position': 'Page {page} sur {total}',

  /**
   * Le repli de tout `fetch` du panel quand la réponse n'a pas de message.
   * Vingt-huit occurrences le répétaient à l'identique ; il n'en reste qu'une.
   */
  'http.failure': 'Échec (HTTP {status})',

  /** Valeur absente dans un tableau. Un tiret cadratin, pas un trait d'union. */
  none: '—',

  /**
   * Durée écoulée, « il y a 27 min ». Cibles, déploiements, sondes et journal
   * la disent tous — voir `lib/relative-time.ts`.
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
  'column.name': 'Name',
  'column.state': 'State',
  'column.status': 'Status',
  'column.type': 'Type',
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
