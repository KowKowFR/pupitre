import { languageOf, type UiLanguage } from '@pupitre/core';
import { getAppSettingsValue } from '@pupitre/db';

/**
 * La langue de l'instance, relue au début de chaque tâche : celle de tout ce
 * que le worker écrit pour quelqu'un — journal d'un déploiement, preflight
 * d'une cible, erreurs, statuts de commit, notifications.
 *
 * Changer la langue dans les paramètres vaut pour la tâche suivante ; ce qui
 * est déjà écrit — les lignes d'un journal, un relevé — garde la sienne.
 */
export async function instanceLanguage(): Promise<UiLanguage> {
  return languageOf((await getAppSettingsValue()).locale);
}
