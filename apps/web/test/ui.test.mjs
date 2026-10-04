import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * The design system's invariants that can be checked without a browser.
 *
 * These tests load the TSX components through `tsx` (see the `test` script) and
 * render them as static HTML: it is enough for what we want to guarantee — what
 * is written, what is disabled, what disappears. The rest of the layers' logic (a
 * drawer's URL, keyboard, confirmation by typing) lives in pure modules, tested
 * directly.
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

/** A test session from a list of permissions. */
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
  it('disables the button and spells out its reason when disabledReason is provided', () => {
    const html = renderToStaticMarkup(
      createElement(Button, { disabledReason: 'Votre rôle ne permet aucun geste ici.' }, 'Détruire'),
    );
    assert.match(html, /<button[^>]*disabled=""/);
    assert.match(html, /class="reason"[^>]*>Votre rôle ne permet aucun geste ici\.</);
    // The reason is linked to the button, not merely set next to it.
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    assert.ok(describedBy);
    assert.match(html, new RegExp(`id="${describedBy}"`));
  });

  it('adds neither a reason nor a disabling without disabledReason', () => {
    const html = renderToStaticMarkup(createElement(Button, null, 'Déployer'));
    assert.doesNotMatch(html, /disabled/);
    assert.doesNotMatch(html, /reason/);
  });

  it('marks work in progress: spinner, inert button, aria-busy', () => {
    const html = renderToStaticMarkup(createElement(Button, { loading: true }, 'Déploiement…'));
    assert.match(html, /disabled=""/);
    assert.match(html, /aria-busy="true"/);
    assert.match(html, /class="spin"/);
  });
});

describe('hiding by permission', () => {
  it('a viewer’s rail has neither tasks, nor log, nor users, nor roles', () => {
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
    // An empty group disappears: no "Administration" without a section.
    assert.deepEqual(groups.map((group) => group.key), ['operations']);
  });

  it('an administrator’s rail shows the fourteen sections, catalog included', () => {
    const keys = visibleNavigation(ADMIN).flatMap((group) => group.sections.map((section) => section.key));
    assert.equal(keys.length, 14);
    assert.ok(keys.includes('catalog'));
  });

  it('the status pages open to whoever composes as to whoever announces, not to the others', () => {
    const keysOf = (can) =>
      visibleNavigation(can).flatMap((group) => group.sections.map((section) => section.key));
    assert.ok(keysOf(session('status_page:announce')).includes('statusPages'));
    assert.ok(keysOf(session('status_page:manage')).includes('statusPages'));
    assert.ok(!keysOf(VIEWER).includes('statusPages'));
  });

  it('the palette reads an action verb in the input', () => {
    assert.deepEqual(splitPaletteVerbs('Redémarrer umami'), { verbs: ['restart'], rest: 'umami' });
    assert.deepEqual(splitPaletteVerbs('prod-1 tester'), { verbs: ['test'], rest: 'prod-1' });
    assert.deepEqual(splitPaletteVerbs('api facturation'), { verbs: [], rest: 'api facturation' });
    assert.deepEqual(splitPaletteVerbs('suspendre'), { verbs: ['pause'], rest: '' });
  });

  it('the palette does not offer a forbidden command', () => {
    assert.deepEqual(visibleCommands(VIEWER), ['theme', 'shortcuts', 'searchRuns']);
    assert.deepEqual(visibleCommands(OPERATOR), [
      'deploy', 'testTargets', 'newApp', 'theme', 'shortcuts',
      'act.test', 'act.editTarget', 'act.deploy', 'searchRuns',
    ]);
    // An action on an object follows the same rule: without `deployment:restart`, no "restart".
    assert.ok(!visibleCommands(OPERATOR).includes('act.restart'));
    assert.ok(visibleCommands(ADMIN).includes('searchLogs') && visibleCommands(ADMIN).includes('settings'));
    assert.ok(visibleCommands(ADMIN).includes('language'));
  });

  it('the › prefix only keeps the commands', () => {
    assert.deepEqual(parsePaletteQuery('› thème'), { query: 'thème', commandsOnly: true });
    assert.deepEqual(parsePaletteQuery('>deploy'), { query: 'deploy', commandsOnly: true });
    assert.deepEqual(parsePaletteQuery('prod-1'), { query: 'prod-1', commandsOnly: false });
  });

  it('the active section follows the path, without "/" capturing everything', () => {
    assert.equal(activeSection('/'), 'dashboard');
    assert.equal(activeSection('/targets/abc'), 'targets');
    assert.equal(activeSection('/catalog'), 'catalog');
    assert.equal(activeSection('/admin/settings/ia'), 'settings');
    assert.equal(activeSection('/account'), null);
  });
});

describe('Drawer', () => {
  it('reads the open item in the URL, and ignores an empty value', () => {
    assert.equal(selectionFrom('?target=prod-1&page=2', 'target'), 'prod-1');
    assert.equal(selectionFrom('?target=', 'target'), null);
    assert.equal(selectionFrom('', 'run'), null);
  });

  it('sets and removes the item without touching the other parameters', () => {
    assert.equal(hrefWithSelection('/targets', '?status=ok', 'target', 'prod-1'), '/targets?status=ok&target=prod-1');
    assert.equal(hrefWithSelection('/targets', '?status=ok&target=prod-1', 'target', null), '/targets?status=ok');
    assert.equal(hrefWithSelection('/targets', '?target=prod-1', 'target', null), '/targets');
  });

  it('J and K move to the neighboring row, without looping at the edges', () => {
    const ids = ['a', 'b', 'c'];
    assert.equal(neighbour(ids, 'b', 1), 'c');
    assert.equal(neighbour(ids, 'b', -1), 'a');
    assert.equal(neighbour(ids, 'c', 1), null);
    assert.equal(neighbour(ids, 'a', -1), null);
  });

  it('translates keys into actions, and goes quiet during an input', () => {
    const nav = { canPrevious: true, canNext: true, hasRecord: true };
    assert.equal(drawerKeyAction({ key: 'j' }, nav), 'next');
    assert.equal(drawerKeyAction({ key: 'K' }, nav), 'previous');
    assert.equal(drawerKeyAction({ key: 'Enter', tag: 'div' }, nav), 'record');
    assert.equal(drawerKeyAction({ key: 'Enter', tag: 'button' }, nav), null);
    assert.equal(drawerKeyAction({ key: 'j', typing: true }, nav), null);
    assert.equal(drawerKeyAction({ key: 'j', metaKey: true }, nav), null);
    assert.equal(drawerKeyAction({ key: 'j' }, { ...nav, canNext: false }), null);
  });

  it('recognizes an input area, but not a checkbox', () => {
    const element = (tagName, type) => ({ tagName, getAttribute: () => type ?? null });
    assert.equal(isTyping(element('INPUT', 'text')), true);
    assert.equal(isTyping(element('TEXTAREA')), true);
    assert.equal(isTyping(element('INPUT', 'checkbox')), false);
    assert.equal(isTyping(element('BUTTON')), false);
  });
});

describe('confirmation by typing the name', () => {
  it('only unlocks on an exact match, case included', () => {
    assert.equal(confirmMatches('blog', 'blog'), true);
    assert.equal(confirmMatches('  blog ', 'blog'), true);
    assert.equal(confirmMatches('Blog', 'blog'), false);
    assert.equal(confirmMatches('blo', 'blog'), false);
    assert.equal(confirmMatches('', ''), false);
  });

  it('reserves the full red for the "data loss" level', () => {
    assert.equal(confirmVariant('data'), 'destructive-solid');
    assert.equal(confirmVariant('trace'), 'destructive');
    assert.equal(confirmVariant('reversible'), 'default');
  });
});
