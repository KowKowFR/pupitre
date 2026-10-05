import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { isFrench, placeholdersOf } from './french.mjs';
import { scanSource } from './scan-source.mjs';

/**
 * The screens' guard (`i18n.test.mjs`), extended to what speaks beyond them: a
 * deployment's log, a driver error, a schema complaint, a backup's failure.
 * These texts are written in `@pupitre/core`, in the worker and in
 * `@pupitre/db`, and follow the instance's language through their
 * dictionaries (the `messages.ts`, `validation.ts`…).
 *
 * The same exceptions as for the screens: logging (`logger.*()`, `log.*()`,
 * `console.*()`) and programming invariants (`new Error()`) are not shown to a
 * user. A file that declares a dictionary is read by the dictionaries' guard,
 * not by this one.
 *
 * `NOT_PRODUCT` lists what stays in French **without being a product
 * message**, with the reason. A file that is not in it can no longer write
 * French, and neither can a new file.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');
const roots = ['packages/core/src', 'apps/worker/src', 'packages/db/src'].map((root) =>
  path.join(repoRoot, root),
);

const NOT_PRODUCT = {
  // Contents already bilingual, inline (`{ fr, en }`): the dictionaries' guard
  // does not see them, the catalog's test does.
  'packages/core/src/catalog/templates.ts': 'catalog templates, bilingual inline',
  'packages/core/src/permissions.ts': 'permission descriptions, bilingual inline',
  'packages/core/src/notifications/types.ts': 'secrets mask, bilingual inline',
  // Built-in checks found again by their sentence (`validation.ts`): the French
  // sentence is the key there.
  'packages/core/src/sources/types.ts': 'built-in check, found by its sentence',
  'packages/db/src/schedules.ts': 'built-in check, found by its sentence',
  'packages/db/src/rbac.ts': 'built-in check, found by its sentence',
};

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function isDictionary(source) {
  return (
    source.includes('Translated<typeof') ||
    /satisfies Bundle</.test(source) ||
    /\bdefineMessages\(/.test(source) ||
    // A dictionary written in one block: `const xCopy = { fr: { … }, en: { … } }`.
    /=\s*\{\s*\n\s*fr:\s*\{[\s\S]*\n\s*en:\s*\{/.test(source)
  );
}

function findings() {
  const problems = [];
  const quiet = new Set();
  for (const root of roots) {
    for (const file of walk(root)) {
      const relative = path.relative(repoRoot, file).split(path.sep).join('/');
      const source = readFileSync(file, 'utf8');
      if (isDictionary(source)) continue;
      const french = scanSource(source, { jsx: false }).strings.filter(({ value }) =>
        isFrench(value),
      );
      if (french.length === 0) {
        quiet.add(relative);
        continue;
      }
      if (relative in NOT_PRODUCT) continue;
      for (const { value, line } of french) {
        problems.push(`${relative}:${line} — "${value.slice(0, 80)}"`);
      }
    }
  }
  return { problems, quiet };
}

describe('product messages, outside the screens', () => {
  it('no longer hard-code French in core, the worker and the database', () => {
    assert.deepEqual(findings().problems, []);
  });

  it('keep no exception for a file that no longer needs one', () => {
    // A `NOT_PRODUCT` entry for a file that went quiet would disarm the guard
    // there without anyone noticing: it is removed.
    const { quiet } = findings();
    const stale = Object.keys(NOT_PRODUCT).filter((file) => quiet.has(file));
    assert.deepEqual(stale, []);
  });

  it('never default the language: whoever renders a sentence says in which', () => {
    // A default language is a sentence that comes out in the wrong one as soon as a
    // caller forgets to pass it — French on an English instance, or the reverse.
    // Required, the compiler finds every caller instead.
    const defaulted = [];
    for (const root of roots) {
      for (const file of walk(root)) {
        const source = readFileSync(file, 'utf8');
        const relative = path.relative(repoRoot, file).split(path.sep).join('/');
        source.split('\n').forEach((line, index) => {
          if (
            /\blanguage\??: UiLanguage = /.test(line) ||
            /\.language \?\? (?:'(?:fr|en)'|DEFAULT_UI_LANGUAGE)/.test(line)
          ) {
            defaulted.push(`${relative}:${index + 1}`);
          }
        });
      }
    }
    assert.deepEqual(defaulted, []);
  });
});

describe('the worker and database dictionaries', () => {
  const sources = [
    ['apps/worker/src/messages.ts', 'workerCopy'],
    ['packages/db/src/messages.ts', 'dbCopy'],
  ];

  const flatten = (dict) => {
    const out = new Map();
    for (const [key, entry] of Object.entries(dict)) {
      if (typeof entry === 'string') out.set(key, entry);
      else for (const [form, text] of Object.entries(entry)) out.set(`${key}.${form}`, text);
    }
    return out;
  };

  it('pair their keys and substitutions, without French in English', async () => {
    const problems = [];
    for (const [file, name] of sources) {
      const bundle = (await import(path.join(repoRoot, file)))[name];
      assert.ok(bundle?.fr && bundle?.en, `${file}: "${name}" not found`);
      const fr = flatten(bundle.fr);
      const en = flatten(bundle.en);
      for (const key of fr.keys())
        if (!en.has(key)) problems.push(`${name} · "${key}" missing in English`);
      for (const key of en.keys())
        if (!fr.has(key)) problems.push(`${name} · "${key}" extra in English`);
      for (const [key, text] of fr) {
        const other = en.get(key);
        if (other === undefined) continue;
        const expected = [...placeholdersOf(text)].sort().join(',');
        const actual = [...placeholdersOf(other)].sort().join(',');
        if (expected !== actual) problems.push(`${name} · "${key}": {${expected}} / {${actual}}`);
        if (isFrench(other)) problems.push(`${name} · "${key}": "${other}"`);
      }
    }
    assert.deepEqual(problems, []);
  });
});
