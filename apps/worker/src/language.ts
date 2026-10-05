import { languageOf, type UiLanguage } from '@pupitre/core';
import { getAppSettingsValue } from '@pupitre/db';

/**
 * The instance's language, read again at the start of each job: that of
 * everything the worker writes for someone — a deployment's log, a target's
 * preflight, errors, commit statuses, notifications.
 *
 * Changing the language in the settings holds for the next job; what is already
 * written — a log's lines, a reading — keeps its own.
 */
export async function instanceLanguage(): Promise<UiLanguage> {
  return languageOf((await getAppSettingsValue()).locale);
}
