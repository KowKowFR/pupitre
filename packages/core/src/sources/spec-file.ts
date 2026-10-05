import type { UiLanguage } from '../i18n.js';
import { safeParseAppSpec, type AppSpec } from '../spec/index.js';
import { issueMessage } from '../validation.js';
import { sourceSay } from './messages.js';

/**
 * Lecture du `pupitre.json` d'un commit.
 *
 * Le fichier ne contient que l'AppSpec, validée par le même schéma Zod que
 * partout ailleurs : ce qui ne passerait pas dans le formulaire du panel ne
 * passe pas davantage par un commit. Une règle de plus, propre au dépôt : le
 * `name` doit être celui de l'application liée. C'est lui qui nomme le projet
 * Compose et le namespace (`app-{slug}`) ; un commit ne doit pas pouvoir
 * déployer sous le nom d'une autre application.
 */

export type SourceSpecResult =
  | { ok: true; spec: AppSpec }
  | { ok: false; issues: string[] };

export function parseSourceSpec(
  content: string,
  expectedName: string,
  language: UiLanguage = 'fr',
): SourceSpecResult {
  const say = sourceSay(language);
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (error) {
    return {
      ok: false,
      issues: [
        say('spec.unreadableJson', {
          error: error instanceof Error ? error.message : String(error),
        }),
      ],
    };
  }

  const parsed = safeParseAppSpec(json);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) =>
        say('spec.issue', {
          path: issue.path.length > 0 ? issue.path.join('.') : 'spec',
          message: issueMessage(issue, language),
        }),
      ),
    };
  }

  if (parsed.data.name !== expectedName) {
    return {
      ok: false,
      issues: [say('spec.wrongName', { actual: parsed.data.name, expected: expectedName })],
    };
  }

  return { ok: true, spec: parsed.data };
}
