import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { formatIssues } from '../src/ai/generate.js';
import { aiCopy } from '../src/ai/messages.js';
import { redactApiKey } from '../src/ai/model.js';
import { s3DestinationConfigSchema } from '../src/backup/destinations.js';
import { monitorUrlSchema } from '../src/monitors/ssrf.js';
import { hostnameSchema } from '../src/proxy/model.js';
import { sourceCopy } from '../src/sources/messages.js';
import { parseSourceSpec } from '../src/sources/spec-file.js';
import { appSpecSchema, slugSchema, volumeSizeSchema } from '../src/spec/app-spec.js';
import { statusPageSlugSchema } from '../src/status-page.js';
import { issueMessage, localizeZodError, validationCopy } from '../src/validation.js';

/**
 * Schema complaints keep their French sentence — tests, the AI's correction loop
 * — and are said again in the screen's language when shown. This file tests
 * that step, and the messages that live from it.
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

describe('Validation complaints — two languages', () => {
  for (const [name, bundle] of Object.entries({
    validation: validationCopy,
    sources: sourceCopy,
    ai: aiCopy,
  })) {
    it(`${name}: same variables, no French in the English`, () => {
      const fr = bundle.fr as Record<string, Entry>;
      const en = bundle.en as Record<string, Entry>;
      for (const key of Object.keys(fr)) {
        assert.ok(en[key] !== undefined, `${key} missing in English`);
        assert.deepEqual(placeholders(en[key] as Entry), placeholders(fr[key] as Entry), key);
        for (const form of forms(en[key] as Entry)) {
          assert.doesNotMatch(form, /[éèêàçùœ«»]/, `${key}: “${form}”`);
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

describe('Validation complaints — said again in the screen’s language', () => {
  it('French stays the default sentence, English renders on request', () => {
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

  it('a built-in check is found by its French sentence', () => {
    const parsed = appSpecSchema.safeParse({ name: 'demo', version: '1.0.0', services: [] });
    assert.ok(!parsed.success);
    const english = localizeZodError(parsed.error, 'en');
    assert.ok(english instanceof z.ZodError);
    assert.ok(english.issues.some((issue) => issue.message === 'at least one service'));
    // The path does not move: `z.flattenError()` files the complaints under the
    // same field.
    assert.deepEqual(
      english.issues.map((issue) => issue.path.join('.')),
      parsed.error.issues.map((issue) => issue.path.join('.')),
    );
  });

  it('a refused domain name, an SSRF refusal', () => {
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

  it('the schemas’ own fixed sentences are all found again', () => {
    // A `.regex(…, '…')` sentence missing from the dictionary reaches an
    // English screen in French: each one is rendered here, never left as is.
    const failures = [
      slugSchema.safeParse('Not A Slug'),
      volumeSizeSchema.safeParse('ten gigs'),
      statusPageSlugSchema.safeParse('-edge-'),
      s3DestinationConfigSchema.safeParse({
        endpoint: 'https://s3.example.com',
        bucket: 'B',
        prefix: '../up',
      }),
    ];
    for (const result of failures) {
      assert.ok(!result.success);
      for (const issue of result.error.issues) {
        const english = issueMessage(issue, 'en');
        assert.doesNotMatch(english, /[éèàç«»]| : /, `still French: ${english}`);
      }
    }
    assert.equal(
      issueMessage(slugSchema.safeParse('Nope').error!.issues[0]!, 'en'),
      'kebab-case name: lowercase letters, digits and dashes',
    );
  });

  it('an unknown complaint stays as is', () => {
    assert.equal(
      issueMessage({ message: 'Too small: expected string' }, 'en'),
      'Too small: expected string',
    );
  });

  it('a commit’s pupitre.json, in English', () => {
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

  it('AI generation: complaints and masked key', () => {
    const parsed = appSpecSchema.safeParse({ name: 'demo', version: '1.0.0', services: [] });
    assert.ok(!parsed.success);
    assert.ok(formatIssues(parsed.error, 'en').includes('services: at least one service'));
    assert.ok(formatIssues(parsed.error, 'fr').includes('services : au moins un service'));
    assert.equal(redactApiKey('refused: sk-abcdefgh1234', null, 'en'), 'refused: [redacted key]');
  });
});
