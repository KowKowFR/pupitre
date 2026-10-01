import type { Translated } from '@pupitre/core';

/**
 * Le catalogue : des applications prêtes à l'emploi, installées en AppSpec.
 *
 * Les textes propres à chaque modèle (résumé, premier accès) vivent avec le
 * modèle, dans `@pupitre/core/catalog` : ajouter un modèle ne touche pas à ce
 * dictionnaire.
 */
const fr = {
  'page.title': 'Catalogue',
  'page.description':
    "Des applications prêtes à l'emploi. Chacune est une AppSpec : elle se relit, se modifie et se déploie comme les vôtres, sur Docker Compose comme sur K3s.",
  'search.placeholder': 'Rechercher une application…',
  'search.label': 'Rechercher dans le catalogue',
  'category.all': 'Toutes',
  'category.monitoring': 'Supervision',
  'category.analytics': 'Analyse',
  'category.content': 'Sites et contenus',
  'category.automation': 'Automatisation et IA',
  'category.devtools': 'Outils de développement',
  'category.productivity': 'Bureau et documents',
  'category.media': 'Médias',
  'category.security': 'Sécurité',
  'category.demo': 'Démonstration',
  'empty.title': 'Aucune application ne correspond',
  'empty.hint': "Essayez un autre mot, ou une autre catégorie. Ce qui manque s'écrit en AppSpec.",
  'card.services': { one: '{count} service', other: '{count} services' },
  'card.install': 'Installer',

  'drawer.kind': 'Catalogue',
  'drawer.website': 'Site officiel',
  'drawer.section.run': 'Ce qui va tourner',
  'drawer.section.images': 'Images',
  'drawer.section.firstRun': 'Au premier accès',
  'drawer.section.install': 'Installation',
  'drawer.images.note':
    "Images officielles de l'éditeur, tirées par la cible au déploiement. Les scans de sécurité s'y appliquent comme aux vôtres.",
  'field.name': 'Nom',
  'field.name.help': 'Le nom de l’application dans Pupitre, et de son projet sur la cible.',
  'field.name.taken': 'Une application porte déjà ce nom.',
  'field.host': 'Domaine',
  'field.host.help':
    'Facultatif. Sans domaine, la cible publie l’application sur un port de sa plage.',
  'field.host.wanted':
    "Cette application a besoin de son domaine : sans lui, elle démarre mais se comporte mal (liens, cookies, redirections).",
  'field.tls': 'HTTPS',
  'field.tls.help': 'Certificat obtenu par le proxy de la cible.',
  'field.secret.help': 'Vous en aurez besoin pour vous connecter. Chiffré, jamais réaffiché.',
  'field.secret.generate': 'Générer',
  'field.secret.copied': 'Copié',
  'secrets.generated': {
    one: '{count} autre secret sera généré, chiffré, et ne se relira jamais.',
    other: '{count} autres secrets seront générés, chiffrés, et ne se reliront jamais.',
  },
  'submit': 'Installer',
  'submit.pending': 'Installation…',
  'invalid.name': 'Le nom est en kebab-case : minuscules, chiffres et tirets.',
  'invalid.secret': 'Choisissez le mot de passe {name}.',
  'toast.installed': '{name} installée',
  'toast.installed.detail': 'Choisissez une cible pour la déployer.',
  'toast.deploy': 'Déployer',
  'error.notFound': 'Modèle « {id} » introuvable',
  'error.secretNotAsked': '{name} ne fait pas partie des secrets demandés par ce modèle.',
  'error.secretMissing': 'Le secret {name} est requis pour se connecter à l’application.',
} as const;

const en: Translated<typeof fr> = {
  'page.title': 'Catalog',
  'page.description':
    'Ready-to-use applications. Each one is an AppSpec: it can be read, edited and deployed like yours, on Docker Compose as on K3s.',
  'search.placeholder': 'Search an application…',
  'search.label': 'Search the catalog',
  'category.all': 'All',
  'category.monitoring': 'Monitoring',
  'category.analytics': 'Analytics',
  'category.content': 'Sites and content',
  'category.automation': 'Automation and AI',
  'category.devtools': 'Developer tools',
  'category.productivity': 'Office and documents',
  'category.media': 'Media',
  'category.security': 'Security',
  'category.demo': 'Demo',
  'empty.title': 'No application matches',
  'empty.hint': 'Try another word, or another category. What is missing can be written as an AppSpec.',
  'card.services': { one: '{count} service', other: '{count} services' },
  'card.install': 'Install',

  'drawer.kind': 'Catalog',
  'drawer.website': 'Official site',
  'drawer.section.run': 'What will run',
  'drawer.section.images': 'Images',
  'drawer.section.firstRun': 'On first access',
  'drawer.section.install': 'Installation',
  'drawer.images.note':
    "The publisher's official images, pulled by the target at deployment. Security scans apply to them as to yours.",
  'field.name': 'Name',
  'field.name.help': 'The application name in Pupitre, and of its project on the target.',
  'field.name.taken': 'An application already has this name.',
  'field.host': 'Domain',
  'field.host.help': 'Optional. Without a domain, the target publishes the application on a port from its range.',
  'field.host.wanted':
    'This application needs its domain: without it, it starts but misbehaves (links, cookies, redirects).',
  'field.tls': 'HTTPS',
  'field.tls.help': "Certificate obtained by the target's proxy.",
  'field.secret.help': 'You will need it to sign in. Encrypted, never shown again.',
  'field.secret.generate': 'Generate',
  'field.secret.copied': 'Copied',
  'secrets.generated': {
    one: '{count} other secret will be generated, encrypted, and never shown again.',
    other: '{count} other secrets will be generated, encrypted, and never shown again.',
  },
  'submit': 'Install',
  'submit.pending': 'Installing…',
  'invalid.name': 'The name is kebab-case: lowercase letters, digits and dashes.',
  'invalid.secret': 'Choose the {name} password.',
  'toast.installed': '{name} installed',
  'toast.installed.detail': 'Pick a target to deploy it.',
  'toast.deploy': 'Deploy',
  'error.notFound': 'Template “{id}” not found',
  'error.secretNotAsked': '{name} is not one of the secrets this template asks for.',
  'error.secretMissing': 'The {name} secret is required to sign in to the application.',
};

export const catalog = { fr, en };
