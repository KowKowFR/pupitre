import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The panel browsed over HTTP on the local network — `http://192.168.1.20:3000`
 * — is not a secure origin: `crypto.randomUUID` and `navigator.clipboard` are
 * `undefined` there. A status page that drew its block identifiers from the
 * first one did not display at all ("crypto.randomUUID is not a function").
 * The screens go through `lib/secure-origin.ts`; this file checks it, and that
 * nobody calls the originals again.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');
const HELPER = path.join(src, 'lib', 'secure-origin.ts');
const { copyText, randomUuid } = await import('../src/lib/secure-origin.ts');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** A browser without a secure origin: no Clipboard API, a copy command. */
function insecureBrowser({ copies = true } = {}) {
  const added = [];
  const previous = { navigator: globalThis.navigator, document: globalThis.document };
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
  globalThis.document = {
    activeElement: null,
    body: { appendChild: (node) => added.push(node) },
    createElement: () => {
      const field = { style: {}, value: '', selected: false, removed: false };
      field.setAttribute = () => {};
      field.select = () => (field.selected = true);
      field.remove = () => (field.removed = true);
      return field;
    },
    execCommand: (command) => command === 'copy' && copies && added.at(-1)?.selected === true,
  };
  return {
    added,
    restore() {
      Object.defineProperty(globalThis, 'navigator', {
        value: previous.navigator,
        configurable: true,
        writable: true,
      });
      globalThis.document = previous.document;
    },
  };
}

describe('what a secure origin gives, on every origin', () => {
  it('draws version 4 UUIDs, all different', () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i += 1) {
      const id = randomUuid();
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      seen.add(id);
    }
    assert.equal(seen.size, 2000);
  });

  it('copies through a hidden field when the Clipboard API is missing, and cleans up', async () => {
    const browser = insecureBrowser();
    try {
      assert.equal(await copyText('pup_secret'), true);
      assert.equal(browser.added.length, 1);
      assert.equal(browser.added[0].value, 'pup_secret');
      assert.equal(browser.added[0].removed, true);
    } finally {
      browser.restore();
    }
  });

  it('puts its field inside the dialog that holds the focus — a drawer keeps the focus', async () => {
    const browser = insecureBrowser();
    try {
      const inDialog = [];
      globalThis.document.activeElement = {
        closest: (selector) =>
          selector.includes('dialog') ? { appendChild: (node) => inDialog.push(node) } : null,
        focus: () => {},
      };
      assert.equal(await copyText('pup_secret'), false, 'the fake copy command only sees <body>');
      assert.equal(inDialog.length, 1);
      assert.equal(browser.added.length, 0);
      assert.equal(inDialog[0].removed, true);
    } finally {
      browser.restore();
    }
  });

  it('says so when nothing could be copied', async () => {
    const browser = insecureBrowser({ copies: false });
    try {
      assert.equal(await copyText('pup_secret'), false);
      assert.equal(browser.added[0].removed, true);
    } finally {
      browser.restore();
    }
  });

  it('uses the Clipboard API when there is one, and falls back if it refuses', async () => {
    const browser = insecureBrowser();
    try {
      const written = [];
      globalThis.navigator = { clipboard: { writeText: async (text) => void written.push(text) } };
      assert.equal(await copyText('a'), true);
      assert.deepEqual(written, ['a']);
      assert.equal(browser.added.length, 0);

      globalThis.navigator = {
        clipboard: { writeText: async () => Promise.reject(new Error('denied')) },
      };
      assert.equal(await copyText('b'), true);
      assert.equal(browser.added.length, 1);
    } finally {
      browser.restore();
    }
  });

  it('no screen calls crypto.randomUUID or navigator.clipboard directly', () => {
    const offenders = [];
    for (const file of walk(src)) {
      if (file === HELPER) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (/\bcrypto\.randomUUID\b|\bnavigator\.clipboard\b/.test(line)) {
            offenders.push(`${path.relative(src, file)}:${index + 1}`);
          }
        });
    }
    assert.deepEqual(offenders, [], 'use randomUuid() / copyText() from lib/secure-origin.ts');
  });
});
