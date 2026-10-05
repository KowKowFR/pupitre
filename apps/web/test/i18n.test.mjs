import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { isFrench, placeholdersOf } from './french.mjs';
import { scanSource } from './scan-source.mjs';

/**
 * The bilingualism's anti-regression guard.
 *
 * ── What it catches, and why it exists ──────────────────────────────────────
 * `Translated<typeof fr>` already fails the build when a key is missing or extra.
 * It is the main guard, and it is unstoppable: nobody can ship an orphan key.
 * Three things remain that a type does not see, and that this file checks:
 *
 *   1. an English value **left in French** — same key, same shape, but nobody
 *      translated it;
 *   2. a `{name}` substitution **lost on the way** — the sentence compiles, and
 *      shows "Target {name} not found" to the user;
 *   3. a visible string **hard-coded** in a component, which therefore completely
 *      escapes the mechanism and will never be translated.
 *
 * The third is the most important: it is through there that a second language
 * dies. A hurried contributor adds a button, writes "Save" between two tags,
 * everything compiles, everything works in French, and the English screen now
 * has a French word. Three weeks of that are enough.
 *
 * ── What it does not claim to do ────────────────────────────────────────────
 * It does not judge a translation's *quality*. A flat or word-for-word English
 * sentence passes. The glossary and the review take care of that.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(here, '..');
const srcRoot = path.join(webRoot, 'src');
const messagesRoot = path.join(srcRoot, 'i18n', 'messages');

/**
 * The surfaces another piece of work is redoing in parallel, left in French
 * knowingly until it is done. Empty: the whole panel is translated. The mechanism
 * stays for next time — and if someone forgets to remove a line, nothing breaks:
 * the guard simply becomes stricter.
 */
const NOT_YET_TRANSLATED = [];

/**
 * Files whose French strings are data, not interface: the dictionaries
 * themselves, and the plumbing that renders them.
 */
const NOT_UI = [messagesRoot, path.join(srcRoot, 'i18n')];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function under(file, roots) {
  return roots.some((root) => file === root || file.startsWith(root + path.sep));
}

/**
 * The escape hatch, and its reason for being.
 *
 * Some of a component's French strings are **not** interface: the shell scripts
 * the targets help gives to copy and paste are the typical case. Translating a
 * script's comments in a dictionary would produce a script that no longer matches
 * the repository's, and it is not a sentence, it is a file.
 *
 * Rather than a list of exceptions kept at a distance — which goes stale as soon
 * as the code moves —, the exemption is set **on the line**, with an `i18n-ignore`
 * comment that must say why. It shows in review, next to what it exempts, and it
 * disappears with the code it covered.
 */
function exempted(lines, line) {
  // The mark covers the declaration it precedes: we go up as long as the lines
  // touch. An empty line closes the exemption — that is what prevents it from
  // silently extending to the rest of the file.
  for (let index = line - 1; index >= 0 && index > line - 14; index -= 1) {
    const text = lines[index] ?? '';
    if (text.includes('i18n-ignore')) return true;
    if (index < line - 1 && text.trim() === '') return false;
  }
  return false;
}

function isBundle(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.fr === 'object' &&
    value.fr !== null &&
    typeof value.en === 'object' &&
    value.en !== null
  );
}

/** Flattens an entry — plain string or plural forms — into key/text pairs. */
function flatten(dict) {
  const out = new Map();
  for (const [key, entry] of Object.entries(dict)) {
    if (typeof entry === 'string') out.set(key, entry);
    else for (const [form, text] of Object.entries(entry)) out.set(`${key}.${form}`, text);
  }
  return out;
}

async function loadBundles() {
  const found = [];
  for (const file of readdirSync(messagesRoot).filter((name) => name.endsWith('.ts'))) {
    const loaded = await import(path.join(messagesRoot, file));
    for (const [name, value] of Object.entries(loaded)) {
      if (isBundle(value)) found.push({ file, name, bundle: value });
    }
  }
  return found;
}

describe('the panel dictionaries', () => {
  it('finds at least one — otherwise the guard guards nothing', async () => {
    const bundles = await loadBundles();
    assert.ok(bundles.length > 0, `no dictionary found in ${messagesRoot}`);
  });

  it('pair their keys exactly', async () => {
    const problems = [];
    for (const { file, name, bundle } of await loadBundles()) {
      const fr = new Set(Object.keys(bundle.fr));
      const en = new Set(Object.keys(bundle.en));
      for (const key of fr) if (!en.has(key)) problems.push(`${file} · ${name} · "${key}" missing in English`);
      for (const key of en) if (!fr.has(key)) problems.push(`${file} · ${name} · "${key}" extra in English`);
    }
    assert.deepEqual(problems, []);
  });

  it('keep the same plural shape on both sides', async () => {
    const problems = [];
    for (const { file, name, bundle } of await loadBundles()) {
      for (const [key, entry] of Object.entries(bundle.fr)) {
        const other = bundle.en[key];
        if (other === undefined) continue;
        const frPlural = typeof entry !== 'string';
        const enPlural = typeof other !== 'string';
        if (frPlural !== enPlural) {
          problems.push(`${file} · ${name} · "${key}" is plural on one side only`);
        }
        if (frPlural && enPlural) {
          for (const form of ['one', 'other']) {
            if (typeof other[form] !== 'string') {
              problems.push(`${file} · ${name} · "${key}" has no "${form}" form in English`);
            }
          }
        }
      }
    }
    assert.deepEqual(problems, []);
  });

  it('keep their substitutions', async () => {
    const problems = [];
    for (const { file, name, bundle } of await loadBundles()) {
      const fr = flatten(bundle.fr);
      const en = flatten(bundle.en);
      for (const [key, frText] of fr) {
        const enText = en.get(key);
        if (enText === undefined) continue;
        const expected = [...placeholdersOf(frText)].sort();
        const actual = [...placeholdersOf(enText)].sort();
        if (expected.join(',') !== actual.join(',')) {
          problems.push(
            `${file} · ${name} · "${key}": {${expected.join('} {')}} on one side, {${actual.join('} {')}} on the other`,
          );
        }
      }
    }
    assert.deepEqual(problems, []);
  });

  it('left no French on the English side', async () => {
    const problems = [];
    for (const { file, name, bundle } of await loadBundles()) {
      for (const [key, text] of flatten(bundle.en)) {
        if (isFrench(text)) problems.push(`${file} · ${name} · "${key}": "${text}"`);
      }
    }
    assert.deepEqual(problems, []);
  });

  it('have no empty value', async () => {
    const problems = [];
    for (const { file, name, bundle } of await loadBundles()) {
      for (const lang of ['fr', 'en']) {
        for (const [key, text] of flatten(bundle[lang])) {
          if (String(text).trim() === '') problems.push(`${file} · ${name} · ${lang} · "${key}"`);
        }
      }
    }
    assert.deepEqual(problems, []);
  });
});

describe('@pupitre/core’s catalogs', () => {
  it('pair their keys and leave no French in English', async () => {
    let core;
    try {
      core = await import('@pupitre/core');
    } catch (error) {
      assert.fail(
        `@pupitre/core is not built — run "pnpm build:packages" before the tests (${error.message})`,
      );
    }

    const problems = [];
    for (const [name, value] of Object.entries(core)) {
      if (!isBundle(value)) continue;
      const fr = new Set(Object.keys(value.fr));
      const en = new Set(Object.keys(value.en));
      for (const key of fr) if (!en.has(key)) problems.push(`${name} · "${key}" missing in English`);
      for (const key of en) if (!fr.has(key)) problems.push(`${name} · "${key}" extra in English`);
      for (const [key, text] of flatten(value.en)) {
        if (isFrench(text)) problems.push(`${name} · "${key}": "${text}"`);
      }
    }
    assert.deepEqual(problems, []);
  });
});

describe('the build guard itself', () => {
  /**
   * `Translated<typeof fr>` is the main guard: it is what makes an orphan key
   * impossible to ship. But it only applies if someone writes it. A contributor who
   * declares `const en = { … }` without the annotation gets a dictionary that
   * compiles, works in French, and no longer has any checked parity — the guard
   * disarmed itself, silently, and nothing would say so before the first
   * half-English screen.
   *
   * This test therefore checks the guard rather than the translations: every file
   * that declares a `const fr` must declare its annotated `en` right next to it.
   */
  it('is armed wherever there is a dictionary', () => {
    const roots = [messagesRoot, path.join(webRoot, '..', '..', 'packages', 'core', 'src')];
    const problems = [];
    for (const root of roots) {
      for (const file of walk(root)) {
        const source = readFileSync(file, 'utf8');
        if (!/\bconst fr\b\s*[:=]/.test(source)) continue;
        if (source.includes('Translated<typeof fr>')) continue;
        // `satisfies Bundle<…>` on the whole object constrains both columns by the same
        // type: it is the same guarantee, written differently.
        if (/satisfies Bundle</.test(source)) continue;
        problems.push(path.relative(webRoot, file));
      }
    }
    assert.deepEqual(problems, []);
  });
});

describe('the screens', () => {
  it('no longer hard-code a single visible string', () => {
    const problems = [];
    for (const file of walk(srcRoot)) {
      if (under(file, NOT_UI) || under(file, NOT_YET_TRANSLATED)) continue;
      const source = readFileSync(file, 'utf8');
      const lines = source.split('\n');
      const { strings, jsxTexts } = scanSource(source, { jsx: file.endsWith('.tsx') });
      const relative = path.relative(webRoot, file);
      for (const { value, line } of [...strings, ...jsxTexts]) {
        if (!isFrench(value)) continue;
        if (exempted(lines, line)) continue;
        problems.push(`${relative}:${line} — "${value.slice(0, 80)}"`);
      }
    }
    assert.deepEqual(problems, []);
  });

  it('no longer make plurals by hand', () => {
    /**
     * `${n > 1 ? 's' : ''}` does not survive English: "0 targets" takes an "s" the
     * condition does not give. The pattern is looked for as is because it cannot mean
     * anything else.
     */
    const pattern = /[><=]\s*1\s*\?\s*['"]s['"]|\?\s*['"]s['"]\s*:\s*['"]{2}/;
    const problems = [];
    for (const file of walk(srcRoot)) {
      if (under(file, NOT_UI) || under(file, NOT_YET_TRANSLATED)) continue;
      const source = readFileSync(file, 'utf8');
      source.split('\n').forEach((text, index) => {
        if (pattern.test(text)) problems.push(`${path.relative(webRoot, file)}:${index + 1} — ${text.trim()}`);
      });
    }
    assert.deepEqual(problems, []);
  });
});
