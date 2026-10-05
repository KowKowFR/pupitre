import { translator, type Translate, type Translated, type UiLanguage } from '../i18n.js';

/**
 * Ce que la génération par IA dit **à qui la lance** — un échec, les reproches
 * d'une tentative —, dans la langue de l'instance. Ce qu'elle dit au modèle
 * (le prompt, le message de relance) n'est pas ici : ce sont des instructions,
 * écrites dans la langue du prompt.
 */
const fr = {
  truncated:
    'La réponse du modèle a été coupée avant la fin : le plafond de jetons de sortie est trop bas pour cette application. Augmentez « Jetons maximum » dans Paramètres → Intelligence artificielle, ou décrivez une application plus petite.',
  invalidSpec:
    "L'AppSpec produite ne respecte pas le schéma, même après une relance avec les erreurs de validation.",
  timeout: "Le modèle n'a pas répondu dans le délai imparti",
  root: '(racine)',
  issue: '{path} : {message}',
  redacted: '[clé masquée]',
} as const;

const en: Translated<typeof fr> = {
  truncated:
    'The model’s answer was cut off before the end: the output token limit is too low for this application. Raise “Maximum tokens” under Settings → Artificial intelligence, or describe a smaller application.',
  invalidSpec:
    'The AppSpec produced does not match the schema, even after a retry with the validation errors.',
  timeout: 'The model did not answer in time',
  root: '(root)',
  issue: '{path}: {message}',
  redacted: '[redacted key]',
};

export const aiCopy = { fr, en };

export type AiSay = Translate<typeof fr>;

export function aiSay(language: UiLanguage): AiSay {
  return translator(aiCopy, language);
}
