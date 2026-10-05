import type { UiLanguage } from '../i18n.js';
import { safeParseAppSpec, type AppSpec } from '../spec/index.js';
import { issueMessage } from '../validation.js';
import { sourceSay } from './messages.js';

/**
 * Reading a commit's `pupitre.json`.
 *
 * The file only contains the AppSpec, validated by the same Zod schema as
 * everywhere else: what would not pass in the panel's form does not pass through
 * a commit either. One more rule, specific to the repository: the `name` must be
 * the linked application's. It is what names the Compose project and the
 * namespace (`app-{slug}`); a commit must not be able to deploy under another
 * application's name.
 */

export type SourceSpecResult =
  | { ok: true; spec: AppSpec }
  | { ok: false; issues: string[] };

export function parseSourceSpec(
  content: string,
  expectedName: string,
  language: UiLanguage,
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
