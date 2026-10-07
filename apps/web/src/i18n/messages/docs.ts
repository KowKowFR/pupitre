import type { Translated } from '@pupitre/core';

/**
 * The documentation screen — its frame, not its chapters: those are Markdown
 * files, one per language (`src/docs/content/{fr,en}`), and the guard
 * `test/docs.test.mjs` pairs them like the dictionaries.
 */
const fr = {
  'page.title': 'Documentation',
  'page.description':
    'Tout Pupitre, de A à Z : ce qu’il fait, comment il le fait, les procédures pas à pas et des exemples à copier — l’API et le MCP compris.',
  'group.start': 'Prise en main',
  'group.guides': 'Guides',
  'group.automation': 'Automatiser',
  'group.reference': 'Référence',
  'nav.landmark': 'Chapitres de la documentation',
  'toc.title': 'Sur cette page',
  'search.label': 'Chercher dans la documentation',
  'search.placeholder': 'Chercher : rollback, jeton, Traefik, pupitre.json…',
  'search.submit': 'Chercher',
  'search.results': { one: '{count} résultat pour « {query} »', other: '{count} résultats pour « {query} »' },
  'search.none': 'Rien ne correspond à « {query} ». Essayez un autre mot, ou parcourez les chapitres.',
  'search.clear': 'Effacer la recherche',
  'chapter.previous': 'Précédent',
  'chapter.next': 'Suivant',
  'chapter.open': 'Lire le chapitre',
  'callout.note': 'Note',
  'callout.tip': 'Astuce',
  'callout.important': 'Important',
  'callout.warning': 'Attention',
  'callout.caution': 'Prudence',
  'code.copy': 'Copier',
  'code.copied': 'Copié',
  'anchor.label': 'Lien vers cette section',
};

const en: Translated<typeof fr> = {
  'page.title': 'Documentation',
  'page.description':
    'All of Pupitre, from A to Z: what it does, how it does it, step-by-step procedures and examples to copy — the API and MCP included.',
  'group.start': 'Getting started',
  'group.guides': 'Guides',
  'group.automation': 'Automation',
  'group.reference': 'Reference',
  'nav.landmark': 'Documentation chapters',
  'toc.title': 'On this page',
  'search.label': 'Search the documentation',
  'search.placeholder': 'Search: rollback, token, Traefik, pupitre.json…',
  'search.submit': 'Search',
  'search.results': { one: '{count} result for “{query}”', other: '{count} results for “{query}”' },
  'search.none': 'Nothing matches “{query}”. Try another word, or browse the chapters.',
  'search.clear': 'Clear the search',
  'chapter.previous': 'Previous',
  'chapter.next': 'Next',
  'chapter.open': 'Read the chapter',
  'callout.note': 'Note',
  'callout.tip': 'Tip',
  'callout.important': 'Important',
  'callout.warning': 'Warning',
  'callout.caution': 'Caution',
  'code.copy': 'Copy',
  'code.copied': 'Copied',
  'anchor.label': 'Link to this section',
};

export const docs = { fr, en };
