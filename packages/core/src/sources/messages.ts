import { translator, type Translate, type Translated, type UiLanguage } from '../i18n.js';

/**
 * Ce que disent les fournisseurs de code et la lecture de `pupitre.json` à
 * qui les lit : l'écran des intégrations, l'état d'un dépôt lié, le statut
 * d'un commit refusé. Dans la langue de l'instance.
 */
const fr = {
  'github.noInstallation':
    'dépôt sans installation de la GitHub App : reliez-le de nouveau depuis le panel',
  'archive.tooLarge': 'archive du dépôt au-delà de {mib} Mio',
  'gitlab.protectedBranch':
    "{error} — sur une branche protégée, GitLab n'accepte un statut que d'un jeton qui peut y pousser (rôle Maintainer, ou Developer si les développeurs y poussent)",
  'gitlab.noApiScope':
    "jeton sans la portée « api » (il porte : {scopes}) — sans elle, Pupitre ne peut pas écrire l'état d'un déploiement sur un commit",
  'gitlab.noScope': 'aucune',

  'spec.unreadableJson': 'JSON illisible : {error}',
  'spec.wrongName': "name : « {actual} » au lieu de « {expected} », le nom de l'application liée",
  'spec.issue': '{path} : {message}',
} as const;

const en: Translated<typeof fr> = {
  'github.noInstallation':
    'repository without a GitHub App installation: link it again from the panel',
  'archive.tooLarge': 'repository archive larger than {mib} MiB',
  'gitlab.protectedBranch':
    '{error} — on a protected branch, GitLab only accepts a status from a token that can push to it (Maintainer role, or Developer if developers may push)',
  'gitlab.noApiScope':
    'token without the “api” scope (it has: {scopes}) — without it, Pupitre cannot write a deployment’s state on a commit',
  'gitlab.noScope': 'none',

  'spec.unreadableJson': 'unreadable JSON: {error}',
  'spec.wrongName': 'name: “{actual}” instead of “{expected}”, the name of the linked application',
  'spec.issue': '{path}: {message}',
};

export const sourceCopy = { fr, en };

export type SourceSay = Translate<typeof fr>;

export function sourceSay(language: UiLanguage): SourceSay {
  return translator(sourceCopy, language);
}
