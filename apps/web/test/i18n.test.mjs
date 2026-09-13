import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { isFrench, placeholdersOf } from './french.mjs';
import { scanSource } from './scan-source.mjs';

/**
 * La garde anti-régression du bilinguisme.
 *
 * ── Ce qu'elle attrape, et pourquoi elle existe ─────────────────────────────
 * `Translated<typeof fr>` fait déjà échouer la compilation quand une clé
 * manque ou est en trop. C'est la garde principale, et elle est imparable :
 * personne ne peut livrer une clé orpheline. Restent trois choses qu'un type
 * ne voit pas, et que ce fichier vérifie :
 *
 *   1. une valeur anglaise **restée en français** — même clé, même forme, mais
 *      personne ne l'a traduite ;
 *   2. une substitution `{nom}` **perdue en route** — la phrase compile, et
 *      affiche « Cible {name} introuvable » à l'utilisateur ;
 *   3. une chaîne visible **écrite en dur** dans un composant, qui échappe donc
 *      complètement au mécanisme et ne sera jamais traduite.
 *
 * Le troisième est le plus important : c'est par là qu'une seconde langue
 * meurt. Un contributeur pressé ajoute un bouton, écrit « Enregistrer » entre
 * deux balises, tout compile, tout marche en français, et l'écran anglais a
 * désormais un mot français. Trois semaines de cela suffisent.
 *
 * ── Ce qu'elle ne prétend pas faire ─────────────────────────────────────────
 * Elle ne juge pas la *qualité* d'une traduction. Une phrase anglaise plate ou
 * mot à mot passe. Le glossaire et la relecture s'en chargent.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(here, '..');
const srcRoot = path.join(webRoot, 'src');
const messagesRoot = path.join(srcRoot, 'i18n', 'messages');

/**
 * Les deux surfaces que deux autres chantiers refont en parallèle. Elles
 * restent en français, sciemment, et la garde le sait plutôt que de faire
 * semblant. Le jour où elles sont traduites, on retire ces deux lignes — et
 * si quelqu'un les oublie, rien ne casse : la garde devient simplement plus
 * stricte.
 */
const NOT_YET_TRANSLATED = [
  path.join(srcRoot, 'app', '(app)', 'apps', '[id]'),
  path.join(srcRoot, 'app', 'api', 'apps', '[id]'),
];

/**
 * Fichiers dont les chaînes françaises sont de la donnée, pas de l'interface :
 * les dictionnaires eux-mêmes, et la plomberie qui les rend.
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
 * L'échappatoire, et sa raison d'être.
 *
 * Certaines chaînes françaises d'un composant ne sont **pas** de l'interface :
 * les scripts shell que l'aide des cibles donne à copier-coller en sont le cas
 * type. Traduire `# 1 — un compte dédié` produirait un script qui ne
 * correspond plus à celui du dépôt, et ce n'est pas une phrase, c'est un
 * fichier.
 *
 * Plutôt qu'une liste d'exceptions tenue à distance — qui se périme dès que le
 * code bouge —, la dispense se pose **sur la ligne**, avec un commentaire
 * `i18n-ignore` qui doit dire pourquoi. Elle se voit en revue, à côté de ce
 * qu'elle dispense, et elle disparaît avec le code qu'elle couvrait.
 */
function exempted(lines, line) {
  // La marque couvre la déclaration qu'elle précède : on remonte tant que les
  // lignes se touchent. Une ligne vide referme la dispense — c'est ce qui
  // l'empêche de s'étendre silencieusement au reste du fichier.
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

/** Aplatit une entrée — chaîne simple ou formes de pluriel — en couples clé/texte. */
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

describe('les dictionnaires du panel', () => {
  it('en trouve au moins un — sinon la garde ne garde rien', async () => {
    const bundles = await loadBundles();
    assert.ok(bundles.length > 0, `aucun dictionnaire trouvé dans ${messagesRoot}`);
  });

  it('apparient exactement leurs clés', async () => {
    const problems = [];
    for (const { file, name, bundle } of await loadBundles()) {
      const fr = new Set(Object.keys(bundle.fr));
      const en = new Set(Object.keys(bundle.en));
      for (const key of fr) if (!en.has(key)) problems.push(`${file} · ${name} · « ${key} » manque en anglais`);
      for (const key of en) if (!fr.has(key)) problems.push(`${file} · ${name} · « ${key} » en trop en anglais`);
    }
    assert.deepEqual(problems, []);
  });

  it('gardent la même forme de pluriel des deux côtés', async () => {
    const problems = [];
    for (const { file, name, bundle } of await loadBundles()) {
      for (const [key, entry] of Object.entries(bundle.fr)) {
        const other = bundle.en[key];
        if (other === undefined) continue;
        const frPlural = typeof entry !== 'string';
        const enPlural = typeof other !== 'string';
        if (frPlural !== enPlural) {
          problems.push(`${file} · ${name} · « ${key} » est au pluriel d'un seul côté`);
        }
        if (frPlural && enPlural) {
          for (const form of ['one', 'other']) {
            if (typeof other[form] !== 'string') {
              problems.push(`${file} · ${name} · « ${key} » n'a pas de forme « ${form} » en anglais`);
            }
          }
        }
      }
    }
    assert.deepEqual(problems, []);
  });

  it('conservent leurs substitutions', async () => {
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
            `${file} · ${name} · « ${key} » : {${expected.join('} {')}} d'un côté, {${actual.join('} {')}} de l'autre`,
          );
        }
      }
    }
    assert.deepEqual(problems, []);
  });

  it("n'ont pas laissé de français du côté anglais", async () => {
    const problems = [];
    for (const { file, name, bundle } of await loadBundles()) {
      for (const [key, text] of flatten(bundle.en)) {
        if (isFrench(text)) problems.push(`${file} · ${name} · « ${key} » : « ${text} »`);
      }
    }
    assert.deepEqual(problems, []);
  });

  it("n'ont pas de valeur vide", async () => {
    const problems = [];
    for (const { file, name, bundle } of await loadBundles()) {
      for (const lang of ['fr', 'en']) {
        for (const [key, text] of flatten(bundle[lang])) {
          if (String(text).trim() === '') problems.push(`${file} · ${name} · ${lang} · « ${key} »`);
        }
      }
    }
    assert.deepEqual(problems, []);
  });
});

describe('les catalogues de @pupitre/core', () => {
  it('apparient leurs clés et ne laissent pas de français en anglais', async () => {
    let core;
    try {
      core = await import('@pupitre/core');
    } catch (error) {
      assert.fail(
        `@pupitre/core n'est pas construit — lance « pnpm build:packages » avant les tests (${error.message})`,
      );
    }

    const problems = [];
    for (const [name, value] of Object.entries(core)) {
      if (!isBundle(value)) continue;
      const fr = new Set(Object.keys(value.fr));
      const en = new Set(Object.keys(value.en));
      for (const key of fr) if (!en.has(key)) problems.push(`${name} · « ${key} » manque en anglais`);
      for (const key of en) if (!fr.has(key)) problems.push(`${name} · « ${key} » en trop en anglais`);
      for (const [key, text] of flatten(value.en)) {
        if (isFrench(text)) problems.push(`${name} · « ${key} » : « ${text} »`);
      }
    }
    assert.deepEqual(problems, []);
  });
});

describe('la garde de compilation elle-même', () => {
  /**
   * `Translated<typeof fr>` est la garde principale : c'est elle qui rend une
   * clé orpheline impossible à livrer. Mais elle ne s'applique que si
   * quelqu'un l'écrit. Un contributeur qui déclare `const en = { … }` sans
   * l'annotation obtient un dictionnaire qui compile, marche en français, et
   * n'a plus aucune parité vérifiée — la garde s'est désarmée elle-même, en
   * silence, et rien ne le dirait avant le premier écran mi-anglais.
   *
   * Ce test vérifie donc la garde plutôt que les traductions : tout fichier
   * qui déclare un `const fr` doit déclarer son `en` annoté juste à côté.
   */
  it("est armée partout où il y a un dictionnaire", () => {
    const roots = [messagesRoot, path.join(webRoot, '..', '..', 'packages', 'core', 'src')];
    const problems = [];
    for (const root of roots) {
      for (const file of walk(root)) {
        const source = readFileSync(file, 'utf8');
        if (!/\bconst fr\b\s*[:=]/.test(source)) continue;
        if (source.includes('Translated<typeof fr>')) continue;
        // `satisfies Bundle<…>` sur l'objet entier contraint les deux colonnes
        // par le même type : c'est la même garantie, écrite autrement.
        if (/satisfies Bundle</.test(source)) continue;
        problems.push(path.relative(webRoot, file));
      }
    }
    assert.deepEqual(problems, []);
  });
});

describe('les écrans', () => {
  it("n'écrivent plus une seule chaîne visible en dur", () => {
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
        problems.push(`${relative}:${line} — « ${value.slice(0, 80)} »`);
      }
    }
    assert.deepEqual(problems, []);
  });

  it('ne fabriquent plus de pluriel à la main', () => {
    /**
     * `${n > 1 ? 's' : ''}` ne survit pas à l'anglais : « 0 targets » prend un
     * « s » que la condition ne donne pas. Le motif est cherché tel quel parce
     * qu'il ne peut rien vouloir dire d'autre.
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
