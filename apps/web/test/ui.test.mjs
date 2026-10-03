import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Les invariants du design system qui se vérifient sans navigateur.
 *
 * Ces tests chargent les composants TSX par `tsx` (voir le script `test`) et
 * les rendent en HTML statique : c'est suffisant pour ce qu'on veut garantir
 * — ce qui est écrit, ce qui est désactivé, ce qui disparaît. Le reste de la
 * logique des couches (URL d'un drawer, clavier, confirmation par saisie) vit
 * dans des modules purs, testés directement.
 */

const { Button } = await import('../src/components/ui/button.tsx');
const { confirmMatches, confirmVariant } = await import('../src/lib/confirm.ts');
const {
  drawerKeyAction,
  hrefWithSelection,
  isTyping,
  neighbour,
  selectionFrom,
} = await import('../src/lib/drawer-url.ts');
const { activeSection, parsePaletteQuery, splitPaletteVerbs, visibleCommands, visibleNavigation } = await import(
  '../src/lib/navigation.ts'
);

/** Une session de test à partir d'une liste de permissions. */
const session = (...permissions) => (permission) => permissions.includes(permission);

const ADMIN = session(
  'target:read', 'target:create', 'target:update', 'application:read', 'application:create',
  'deployment:read', 'deployment:create', 'monitor:read', 'maintenance:read', 'job:read', 'audit:read',
  'user:manage', 'role:read', 'settings:read', 'settings:manage',
);
const OPERATOR = session(
  'target:read', 'target:update', 'application:read', 'application:create', 'deployment:read',
  'deployment:create', 'monitor:read', 'job:read',
);
const VIEWER = session('target:read', 'application:read', 'deployment:read', 'monitor:read');

describe('Button', () => {
  it('désactive le bouton et écrit sa raison en clair quand disabledReason est fourni', () => {
    const html = renderToStaticMarkup(
      createElement(Button, { disabledReason: 'Votre rôle ne permet aucun geste ici.' }, 'Détruire'),
    );
    assert.match(html, /<button[^>]*disabled=""/);
    assert.match(html, /class="reason"[^>]*>Votre rôle ne permet aucun geste ici\.</);
    // La raison est reliée au bouton, pas seulement posée à côté.
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    assert.ok(describedBy);
    assert.match(html, new RegExp(`id="${describedBy}"`));
  });

  it("n'ajoute ni raison ni désactivation sans disabledReason", () => {
    const html = renderToStaticMarkup(createElement(Button, null, 'Déployer'));
    assert.doesNotMatch(html, /disabled/);
    assert.doesNotMatch(html, /reason/);
  });

  it('marque le travail en cours : spinner, bouton inerte, aria-busy', () => {
    const html = renderToStaticMarkup(createElement(Button, { loading: true }, 'Déploiement…'));
    assert.match(html, /disabled=""/);
    assert.match(html, /aria-busy="true"/);
    assert.match(html, /class="spin"/);
  });
});

describe('masquage par permission', () => {
  it("le rail d'un observateur n'a ni tâches, ni journal, ni utilisateurs, ni rôles", () => {
    const groups = visibleNavigation(VIEWER);
    const keys = groups.flatMap((group) => group.sections.map((section) => section.key));
    assert.deepEqual(keys, [
      'dashboard',
      'targets',
      'applications',
      'servers',
      'deployments',
      'domains',
      'monitoring',
    ]);
    // Un groupe vide disparaît : pas d'« Administration » sans section.
    assert.deepEqual(groups.map((group) => group.key), ['operations']);
  });

  it("le rail d'un administrateur montre les quatorze sections, catalogue compris", () => {
    const keys = visibleNavigation(ADMIN).flatMap((group) => group.sections.map((section) => section.key));
    assert.equal(keys.length, 14);
    assert.ok(keys.includes('catalog'));
  });

  it('la palette lit un verbe d’action dans la saisie', () => {
    assert.deepEqual(splitPaletteVerbs('Redémarrer umami'), { verbs: ['restart'], rest: 'umami' });
    assert.deepEqual(splitPaletteVerbs('prod-1 tester'), { verbs: ['test'], rest: 'prod-1' });
    assert.deepEqual(splitPaletteVerbs('api facturation'), { verbs: [], rest: 'api facturation' });
    assert.deepEqual(splitPaletteVerbs('suspendre'), { verbs: ['pause'], rest: '' });
  });

  it('la palette ne propose pas une commande interdite', () => {
    assert.deepEqual(visibleCommands(VIEWER), ['theme', 'shortcuts', 'searchRuns']);
    assert.deepEqual(visibleCommands(OPERATOR), [
      'deploy', 'testTargets', 'newApp', 'theme', 'shortcuts',
      'act.test', 'act.editTarget', 'act.deploy', 'searchRuns',
    ]);
    // Une action sur un objet suit la même règle : sans `deployment:restart`, pas de « redémarrer ».
    assert.ok(!visibleCommands(OPERATOR).includes('act.restart'));
    assert.ok(visibleCommands(ADMIN).includes('searchLogs') && visibleCommands(ADMIN).includes('settings'));
    assert.ok(visibleCommands(ADMIN).includes('language'));
  });

  it('le préfixe › ne garde que les commandes', () => {
    assert.deepEqual(parsePaletteQuery('› thème'), { query: 'thème', commandsOnly: true });
    assert.deepEqual(parsePaletteQuery('>deploy'), { query: 'deploy', commandsOnly: true });
    assert.deepEqual(parsePaletteQuery('prod-1'), { query: 'prod-1', commandsOnly: false });
  });

  it('la section active suit le chemin, sans que « / » capture tout', () => {
    assert.equal(activeSection('/'), 'dashboard');
    assert.equal(activeSection('/targets/abc'), 'targets');
    assert.equal(activeSection('/catalog'), 'catalog');
    assert.equal(activeSection('/admin/settings/ia'), 'settings');
    assert.equal(activeSection('/account'), null);
  });
});

describe('Drawer', () => {
  it("lit l'élément ouvert dans l'URL, et ignore une valeur vide", () => {
    assert.equal(selectionFrom('?target=prod-1&page=2', 'target'), 'prod-1');
    assert.equal(selectionFrom('?target=', 'target'), null);
    assert.equal(selectionFrom('', 'run'), null);
  });

  it("pose et retire l'élément sans toucher aux autres paramètres", () => {
    assert.equal(hrefWithSelection('/targets', '?status=ok', 'target', 'prod-1'), '/targets?status=ok&target=prod-1');
    assert.equal(hrefWithSelection('/targets', '?status=ok&target=prod-1', 'target', null), '/targets?status=ok');
    assert.equal(hrefWithSelection('/targets', '?target=prod-1', 'target', null), '/targets');
  });

  it('J et K passent à la ligne voisine, sans boucler aux bords', () => {
    const ids = ['a', 'b', 'c'];
    assert.equal(neighbour(ids, 'b', 1), 'c');
    assert.equal(neighbour(ids, 'b', -1), 'a');
    assert.equal(neighbour(ids, 'c', 1), null);
    assert.equal(neighbour(ids, 'a', -1), null);
  });

  it('traduit les touches en actions, et se tait pendant une saisie', () => {
    const nav = { canPrevious: true, canNext: true, hasRecord: true };
    assert.equal(drawerKeyAction({ key: 'j' }, nav), 'next');
    assert.equal(drawerKeyAction({ key: 'K' }, nav), 'previous');
    assert.equal(drawerKeyAction({ key: 'Enter', tag: 'div' }, nav), 'record');
    assert.equal(drawerKeyAction({ key: 'Enter', tag: 'button' }, nav), null);
    assert.equal(drawerKeyAction({ key: 'j', typing: true }, nav), null);
    assert.equal(drawerKeyAction({ key: 'j', metaKey: true }, nav), null);
    assert.equal(drawerKeyAction({ key: 'j' }, { ...nav, canNext: false }), null);
  });

  it("reconnaît une zone de saisie, mais pas une case à cocher", () => {
    const element = (tagName, type) => ({ tagName, getAttribute: () => type ?? null });
    assert.equal(isTyping(element('INPUT', 'text')), true);
    assert.equal(isTyping(element('TEXTAREA')), true);
    assert.equal(isTyping(element('INPUT', 'checkbox')), false);
    assert.equal(isTyping(element('BUTTON')), false);
  });
});

describe('confirmation par saisie du nom', () => {
  it('ne débloque que sur une correspondance exacte, casse comprise', () => {
    assert.equal(confirmMatches('blog', 'blog'), true);
    assert.equal(confirmMatches('  blog ', 'blog'), true);
    assert.equal(confirmMatches('Blog', 'blog'), false);
    assert.equal(confirmMatches('blo', 'blog'), false);
    assert.equal(confirmMatches('', ''), false);
  });

  it('réserve le rouge plein au niveau « perte de données »', () => {
    assert.equal(confirmVariant('data'), 'destructive-solid');
    assert.equal(confirmVariant('trace'), 'destructive');
    assert.equal(confirmVariant('reversible'), 'default');
  });
});
