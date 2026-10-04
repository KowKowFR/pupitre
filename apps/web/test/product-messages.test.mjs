import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { isFrench, placeholdersOf } from './french.mjs';
import { scanSource } from './scan-source.mjs';

/**
 * La garde des écrans (`i18n.test.mjs`), étendue à ce qui parle au-delà d'eux :
 * le journal d'un déploiement, une erreur de driver, un reproche de schéma,
 * l'échec d'une sauvegarde. Ces textes s'écrivent dans `@pupitre/core`, dans
 * le worker et dans `@pupitre/db`, et suivent la langue de l'instance par
 * leurs dictionnaires (les `messages.ts`, `validation.ts`…).
 *
 * Mêmes exceptions que pour les écrans : la journalisation (`logger.*()`,
 * `log.*()`, `console.*()`) et les invariants de programmation (`new
 * Error()`) ne sont pas montrés à un utilisateur. Un fichier qui déclare un
 * dictionnaire est lu par la garde des dictionnaires, pas par celle-ci.
 *
 * `NOT_PRODUCT` liste ce qui reste en français **sans être un message du
 * produit**, avec la raison. La liste se vide quand les commentaires et les
 * journaux passent à l'anglais ; un fichier qui n'y figure pas ne peut plus
 * écrire de français, et un fichier nouveau non plus.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..', '..');
const roots = ['packages/core/src', 'apps/worker/src', 'packages/db/src'].map((root) =>
  path.join(repoRoot, root),
);

const NOT_PRODUCT = {
  // Contenus déjà bilingues, en ligne (`{ fr, en }`) : la garde des
  // dictionnaires ne les voit pas, le test du catalogue si.
  'packages/core/src/catalog/templates.ts': 'modèles du catalogue, bilingues en ligne',
  'packages/core/src/permissions.ts': 'descriptions de permissions, bilingues en ligne',
  'packages/core/src/notifications/types.ts': 'masque des secrets, bilingue en ligne',
  // Ce qui est dit au modèle, pas à l'utilisateur : la langue du prompt.
  'packages/core/src/ai/generate.ts': 'messages au modèle (prompt, relance)',
  'packages/core/src/ai/prompt.ts': 'prompt système',
  'packages/core/src/ai/model.ts': 'repli de MissingApiKeyError — l’écran a le sien',
  // Fichiers déposés sur les machines : des commentaires de configuration.
  'packages/core/src/proxy/traefik/render.ts': 'commentaire d’un fichier généré',
  'packages/core/src/proxy/traefik/install.ts': 'commentaire d’un fichier généré',
  'packages/core/src/proxy/traefik/provider.ts': 'commentaire d’une route d’essai déposée',
  'packages/core/src/drivers/docker/render.ts': 'commentaire d’un fichier généré',
  'packages/core/src/drivers/k3s/render.ts': 'commentaire d’un manifeste généré',
  // Erreurs dont l'écran n'affiche que le code, ou que des données : leur
  // phrase ne sert qu'au journal.
  'packages/core/src/images/registry.ts': 'RegistryError : l’écran rend le code',
  'packages/core/src/capture/cdp.ts': 'échecs de capture, journalisés',
  'apps/worker/src/monitors/capture.ts': 'échecs de capture, journalisés',
  'packages/core/src/ports.ts': 'PortExhaustedError : le driver dit le sien',
  'packages/core/src/proxy/index.ts': 'registre des proxys : invariant',
  'packages/core/src/sources/gitea.ts': 'motifs de comparaison, jamais affichés',
  'packages/core/src/sources/gitlab.ts': 'motifs de comparaison, jamais affichés',
  'packages/core/src/sources/github.ts': 'motifs de comparaison, jamais affichés',
  'packages/db/src/rbac.ts': 'erreurs de rôle : l’écran rend les siennes',
  'packages/db/src/notifications.ts': 'nom de canal pris : l’écran rend le sien',
  'packages/db/src/proxies.ts': 'domaine déjà routé : l’écran rend le sien',
  'packages/db/src/sources.ts': 'liaison en double : l’écran rend la sienne',
  'packages/db/src/status-pages.ts': 'adresse prise : l’écran rend la sienne',
  'packages/db/src/vulnerability-acceptances.ts': 'faille déjà acceptée : l’écran rend la sienne',
  'packages/db/src/monitors.ts': 'MonitorConfigError : l’écran rend la sienne',
  'packages/db/src/scans.ts': 'note technique dans le rapport brut',
  'packages/db/src/backups.ts': 'repli de la raison — le worker donne la sienne',
  // Exploitation : ce qui s'adresse à qui lance le panel, pas à qui s'en sert.
  'packages/core/src/crypto.ts': 'MASTER_KEY : démarrage et exploitation',
  'packages/core/src/settings.ts': 'valeur par défaut d’un réglage (une donnée)',
  'packages/core/src/ssh/client.ts': 'raison de fermeture, journalisée',
  'packages/db/src/seed.ts': 'sortie de la commande de seed',
  'apps/worker/src/env.ts': 'variables d’environnement du worker',
  'apps/worker/src/handlers/app.ts': 'raison d’arrêt d’un flux, journalisée',
  // Contrôles intégrés retrouvés par leur phrase (`validation.ts`) : la phrase
  // française y est la clé.
  'packages/core/src/sources/types.ts': 'contrôle intégré, retrouvé par sa phrase',
  'packages/db/src/schedules.ts': 'contrôle intégré, retrouvé par sa phrase',
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
    // Un dictionnaire écrit d'un bloc : `const xCopy = { fr: { … }, en: { … } }`.
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
        problems.push(`${relative}:${line} — « ${value.slice(0, 80)} »`);
      }
    }
  }
  return { problems, quiet };
}

describe('les messages du produit, hors des écrans', () => {
  it("n'écrivent plus de français en dur dans core, le worker et la base", () => {
    assert.deepEqual(findings().problems, []);
  });

  it('ne gardent pas d’exception pour un fichier qui n’en a plus besoin', () => {
    // Une entrée de `NOT_PRODUCT` pour un fichier devenu muet désarmerait la
    // garde à son endroit sans que personne le voie : on la retire.
    const { quiet } = findings();
    const stale = Object.keys(NOT_PRODUCT).filter((file) => quiet.has(file));
    assert.deepEqual(stale, []);
  });
});

describe('les dictionnaires du worker et de la base', () => {
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

  it('apparient leurs clés et leurs substitutions, sans français en anglais', async () => {
    const problems = [];
    for (const [file, name] of sources) {
      const bundle = (await import(path.join(repoRoot, file)))[name];
      assert.ok(bundle?.fr && bundle?.en, `${file} : « ${name} » introuvable`);
      const fr = flatten(bundle.fr);
      const en = flatten(bundle.en);
      for (const key of fr.keys())
        if (!en.has(key)) problems.push(`${name} · « ${key} » manque en anglais`);
      for (const key of en.keys())
        if (!fr.has(key)) problems.push(`${name} · « ${key} » en trop en anglais`);
      for (const [key, text] of fr) {
        const other = en.get(key);
        if (other === undefined) continue;
        const expected = [...placeholdersOf(text)].sort().join(',');
        const actual = [...placeholdersOf(other)].sort().join(',');
        if (expected !== actual)
          problems.push(`${name} · « ${key} » : {${expected}} / {${actual}}`);
        if (isFrench(other)) problems.push(`${name} · « ${key} » : « ${other} »`);
      }
    }
    assert.deepEqual(problems, []);
  });
});
