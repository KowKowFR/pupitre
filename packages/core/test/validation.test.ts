import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { formatIssues } from '../src/ai/generate.js';
import { aiCopy } from '../src/ai/messages.js';
import { redactApiKey } from '../src/ai/model.js';
import { monitorUrlSchema } from '../src/monitors/ssrf.js';
import { hostnameSchema } from '../src/proxy/model.js';
import { sourceCopy } from '../src/sources/messages.js';
import { parseSourceSpec } from '../src/sources/spec-file.js';
import { appSpecSchema } from '../src/spec/app-spec.js';
import { issueMessage, localizeZodError, validationCopy } from '../src/validation.js';

/**
 * Les reproches des schémas gardent leur phrase française — tests, boucle de
 * correction de l'IA — et se redisent dans la langue de l'écran au moment de
 * les montrer. Ce fichier éprouve ce passage, et les messages qui en vivent.
 */

type Entry = string | Readonly<Record<string, string>>;

function forms(value: Entry): string[] {
  return typeof value === 'string' ? [value] : Object.values(value);
}

function placeholders(value: Entry): string[] {
  const names = new Set<string>();
  for (const form of forms(value)) {
    for (const match of form.matchAll(/\{(\w+)\}/g)) names.add(match[1] ?? '');
  }
  return [...names].sort();
}

describe('Reproches de validation — deux langues', () => {
  for (const [name, bundle] of Object.entries({
    validation: validationCopy,
    sources: sourceCopy,
    ai: aiCopy,
  })) {
    it(`${name} : mêmes variables, pas de français dans l'anglais`, () => {
      const fr = bundle.fr as Record<string, Entry>;
      const en = bundle.en as Record<string, Entry>;
      for (const key of Object.keys(fr)) {
        assert.ok(en[key] !== undefined, `${key} manque en anglais`);
        assert.deepEqual(placeholders(en[key] as Entry), placeholders(fr[key] as Entry), key);
        for (const form of forms(en[key] as Entry)) {
          assert.doesNotMatch(form, /[éèêàçùœ«»]/, `${key} : « ${form} »`);
        }
      }
    });
  }
});

const service = (name: string, exposed = false) => ({
  name,
  source: { type: 'image', ref: 'nginx:1.27' },
  port: 80,
  exposed,
});

describe('Reproches de validation — redits dans la langue de l’écran', () => {
  it('le français reste la phrase par défaut, l’anglais se rend à la demande', () => {
    const parsed = appSpecSchema.safeParse({
      name: 'demo',
      version: '1.0.0',
      services: [service('web', true), service('web')],
    });
    assert.ok(!parsed.success);
    const issue = parsed.error.issues.find((candidate) => candidate.path.join('.') === 'services');
    assert.ok(issue);
    assert.equal(issue.message, 'noms de services dupliqués : web');
    assert.equal(issueMessage(issue, 'en'), 'duplicate service names: web');
    assert.equal(issueMessage(issue, 'fr'), 'noms de services dupliqués : web');
  });

  it('un contrôle intégré se retrouve par sa phrase française', () => {
    const parsed = appSpecSchema.safeParse({ name: 'demo', version: '1.0.0', services: [] });
    assert.ok(!parsed.success);
    const english = localizeZodError(parsed.error, 'en');
    assert.ok(english instanceof z.ZodError);
    assert.ok(english.issues.some((issue) => issue.message === 'at least one service'));
    // Le chemin ne bouge pas : `z.flattenError()` range les reproches au même champ.
    assert.deepEqual(
      english.issues.map((issue) => issue.path.join('.')),
      parsed.error.issues.map((issue) => issue.path.join('.')),
    );
  });

  it('un nom de domaine refusé, un refus SSRF', () => {
    const host = hostnameSchema.safeParse('*.example.com');
    assert.ok(!host.success);
    assert.equal(
      issueMessage(host.error.issues[0]!, 'en'),
      '“*.example.com”: wildcards are not supported',
    );

    const url = monitorUrlSchema.safeParse('http://localhost:3000/');
    assert.ok(!url.success);
    const refusal = url.error.issues[0]!;
    assert.notEqual(issueMessage(refusal, 'en'), refusal.message);
    assert.doesNotMatch(issueMessage(refusal, 'en'), /[éèàç«»]/);
  });

  it('un reproche inconnu reste tel quel', () => {
    assert.equal(
      issueMessage({ message: 'Too small: expected string' }, 'en'),
      'Too small: expected string',
    );
  });

  it('le pupitre.json d’un commit, en anglais', () => {
    const wrong = parseSourceSpec(
      JSON.stringify({ name: 'autre', version: '1.0.0', services: [service('web', true)] }),
      'demo',
      'en',
    );
    assert.ok(!wrong.ok);
    assert.deepEqual(wrong.issues, [
      'name: “autre” instead of “demo”, the name of the linked application',
    ]);

    const unreadable = parseSourceSpec('{', 'demo', 'en');
    assert.ok(!unreadable.ok);
    assert.match(unreadable.issues[0] ?? '', /^unreadable JSON: /);
  });

  it('la génération par IA : reproches et clé masquée', () => {
    const parsed = appSpecSchema.safeParse({ name: 'demo', version: '1.0.0', services: [] });
    assert.ok(!parsed.success);
    assert.ok(formatIssues(parsed.error, 'en').includes('services: at least one service'));
    assert.ok(formatIssues(parsed.error).includes('services : au moins un service'));
    assert.equal(redactApiKey('refused: sk-abcdefgh1234', null, 'en'), 'refused: [redacted key]');
  });
});
