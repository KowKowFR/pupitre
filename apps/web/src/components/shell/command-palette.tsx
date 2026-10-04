'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Command } from 'cmdk';
import {
  Activity,
  BookOpen,
  Boxes,
  ChevronRight,
  Clock,
  Globe,
  History,
  Keyboard,
  KeyRound,
  Languages,
  LayoutGrid,
  Moon,
  Pause,
  Pencil,
  Play,
  Plus,
  Radar,
  RefreshCw,
  Rocket,
  RotateCw,
  ScrollText,
  Search,
  Server,
  ServerCog,
  SlidersHorizontal,
  Sun,
  SunMoon,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { matchScore, type Translate } from '@pupitre/core';
import { SETTINGS_GROUPS, groupSections } from '@/app/(app)/admin/settings/sections';
import type { SearchHit } from '@/app/api/search/route';
import { Kbd } from '@/components/ui/kbd';
import { useT } from '@/i18n/client';
import { chrome } from '@/i18n/messages/chrome';
import { settings as settingsMessages } from '@/i18n/messages/settings';
import {
  PALETTE_VERBS,
  parsePaletteQuery,
  splitPaletteVerbs,
  type CommandKey,
  type PaletteVerb,
} from '@/lib/navigation';
import { applyTheme, parseTheme, type ThemeChoice } from '@/lib/theme';
import { toast } from '@/lib/toast';
import { SECTION_ICON } from './section-icons';
import type { PaletteScope, ShellSection } from './shell-provider';

/**
 * The ⌘K palette — 640 px, 96 px from the top, `pp-cmdk` entrance.
 *
 * What it renders, in order: the recent items (empty field), the actions, the
 * suggestions, "Go to", the objects, the preferences; an empty group is hidden.
 * The `›` prefix only keeps the commands.
 *
 * - **The objects** come from `GET /api/search`, which only reads what the
 *   session is allowed to see, with a tolerant match (accents, letters in order,
 *   typos).
 * - **The actions** are asked for in two ways: through a verb typed with the name
 *   ("restart umami", "test prod-1"), or through → on a highlighted object, which
 *   opens the list of what can be done with it. An action that interrupts a
 *   service asks for a confirmation, in the palette itself. A forbidden action
 *   does not appear — neither greyed out nor explained.
 *
 * The filtering is done here rather than by cmdk: the `›` prefix, the objects
 * already filtered by the server and the hiding of empty groups cannot be
 * expressed with its fuzzy filter.
 */

type Group =
  'recent' | 'actions' | 'suggestions' | 'goto' | 'objects' | 'elsewhere' | 'preferences';

type Item = {
  id: string;
  group: Group;
  icon: LucideIcon;
  title: string;
  meta: string;
  verb: 'open' | 'run';
  words: string;
  isCommand: boolean;
  perform: () => void;
  /** The object behind the row: → opens its actions. */
  hit?: SearchHit;
};

/** An action on a found object. */
type Action = {
  key: string;
  verb: PaletteVerb | 'open';
  icon: LucideIcon;
  title: string;
  meta: string;
  /** An action that interrupts a service goes through a confirmation. */
  confirm?: string;
  run: () => void | Promise<void>;
};

/** A recently opened item, kept in this browser only. */
type Recent = { kind: SearchHit['kind']; id: string; title: string; meta: string; href: string };

const RECENT_KEY = 'pupitre.palette.recent';
const RECENT_LIMIT = 6;

const GROUP_ORDER: readonly Group[] = [
  'recent',
  'actions',
  'suggestions',
  'goto',
  'objects',
  'elsewhere',
  'preferences',
];
const GROUP_LABEL = {
  recent: 'palette.group.recent',
  actions: 'palette.group.actions',
  suggestions: 'palette.group.suggestions',
  goto: 'palette.group.goto',
  objects: 'palette.group.objects',
  elsewhere: 'palette.group.elsewhere',
  preferences: 'palette.group.preferences',
} as const;

const KIND_ICON: Record<SearchHit['kind'], LucideIcon> = {
  target: Server,
  application: Boxes,
  running: Activity,
  deployment: Rocket,
  monitor: Radar,
  domain: Globe,
  role: KeyRound,
  template: LayoutGrid,
};

function readRecents(): Recent[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as Recent[]).slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

function rememberRecent(entry: Recent) {
  try {
    const next = [entry, ...readRecents().filter((item) => item.href !== entry.href)];
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next.slice(0, RECENT_LIMIT)));
  } catch {
    // Storage refused (private browsing): the palette does without.
  }
}

export function CommandPalette({
  open,
  scope,
  onOpenChange,
  onScopeChange,
  sections,
  commands,
  onShowShortcuts,
}: {
  open: boolean;
  scope: PaletteScope;
  onOpenChange: (open: boolean) => void;
  onScopeChange: (scope: PaletteScope) => void;
  sections: ShellSection[];
  commands: CommandKey[];
  onShowShortcuts: () => void;
}) {
  const t = useT(chrome);
  const ts = useT(settingsMessages);
  const router = useRouter();
  const [raw, setRaw] = React.useState('');
  const [found, setFound] = React.useState<{ key: string; items: SearchHit[] }>({
    key: '',
    items: [],
  });
  const [searching, setSearching] = React.useState(false);
  const [active, setActive] = React.useState('');
  /** The object whose actions are listed (→), or `null`. */
  const [focus, setFocus] = React.useState<SearchHit | null>(null);
  /** The action waiting for its confirmation, or `null`. */
  const [confirming, setConfirming] = React.useState<Action | null>(null);
  /** The input from before a sub-view: it is found again when coming back. */
  const [saved, setSaved] = React.useState('');
  // Read once per opening: the shell mounts the palette again each time.
  const [theme] = React.useState<ThemeChoice>(() => {
    if (typeof document === 'undefined') return 'system';
    const root = document.documentElement.classList;
    return parseTheme(root.contains('dark') ? 'dark' : root.contains('light') ? 'light' : null);
  });
  const [recents] = React.useState<Recent[]>(() =>
    typeof window === 'undefined' ? [] : readRecents(),
  );

  const can = (key: CommandKey) => commands.includes(key);
  const { query, commandsOnly } = parsePaletteQuery(raw);
  const { verbs, rest } = splitPaletteVerbs(query);
  // A typed verb one is not allowed to exercise does not count: the input stays an
  // ordinary search, and nothing forbidden appears.
  const usableVerbs = verbs.filter((verb) => allowedVerb(verb, can));
  const verbKinds = [...new Set(usableVerbs.flatMap((verb) => PALETTE_VERBS[verb].kinds))];

  const request =
    scope === 'deploy'
      ? { q: query, kinds: 'application' }
      : usableVerbs.length > 0
        ? { q: rest, kinds: verbKinds.join(',') }
        : { q: query, kinds: '' };
  const searchKey = `${request.kinds}|${request.q}`;
  const idle =
    focus !== null ||
    confirming !== null ||
    commandsOnly ||
    (scope === null && query === '' && usableVerbs.length === 0);
  // A previous input's results never show under the next one.
  const hits = !idle && found.key === searchKey ? found.items : [];

  // Object search, with a slight delay so as not to query at each keystroke.
  React.useEffect(() => {
    if (!open || idle) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      const params = new URLSearchParams({ q: request.q });
      if (request.kinds) params.set('kinds', request.kinds);
      try {
        const response = await fetch(`/api/search?${params}`, { signal: controller.signal });
        if (response.ok) {
          const { items } = (await response.json()) as { items: SearchHit[] };
          setFound({ key: searchKey, items });
        }
      } catch {
        // Search abandoned or network cut: the palette keeps its commands.
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 140);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [open, idle, request.q, request.kinds, searchKey]);

  function go(href: string) {
    onOpenChange(false);
    router.push(href as never);
  }

  function open_(hit: SearchHit) {
    const href = hrefOf(hit);
    rememberRecent({ kind: hit.kind, id: hit.id, title: titleOf(hit), meta: metaOf(hit, t), href });
    go(href);
  }

  async function call(path: string, init: RequestInit): Promise<boolean> {
    const response = await fetch(path, init).catch(() => null);
    if (response?.ok) return true;
    const body = (await response?.json().catch(() => ({}))) as
      { error?: { message?: string } } | undefined;
    toast({
      title: t('palette.action.failed'),
      description: body?.error?.message ?? t('palette.action.failed.detail'),
      tone: 'danger',
    });
    return false;
  }

  /** What can be done with an object, according to its permissions. "Open" first. */
  function actionsOf(hit: SearchHit): Action[] {
    const list: Action[] = [
      {
        key: 'open',
        verb: 'open',
        icon: KIND_ICON[hit.kind],
        title: t('palette.action.open', { name: titleOf(hit) }),
        meta: metaOf(hit, t),
        run: () => open_(hit),
      },
    ];
    switch (hit.kind) {
      case 'target':
        if (can('act.test'))
          list.push({
            key: 'test',
            verb: 'test',
            icon: RefreshCw,
            title: t('palette.action.test', { name: hit.title }),
            meta: t('palette.action.test.meta'),
            run: async () => {
              onOpenChange(false);
              if (await call(`/api/targets/${hit.id}/preflight`, { method: 'POST' }))
                toast({
                  title: t('palette.toast.tested', { name: hit.title }),
                  tone: 'accent',
                  action: {
                    label: t('palette.toast.preflight.follow'),
                    href: `/targets?target=${hit.id}`,
                  },
                });
            },
          });
        if (can('act.editTarget'))
          list.push({
            key: 'edit',
            verb: 'edit',
            icon: Pencil,
            title: t('palette.action.edit', { name: hit.title }),
            meta: t('palette.action.edit.meta'),
            run: () => go(`/targets?target=${hit.id}&edit=1`),
          });
        break;
      case 'application':
        if (can('act.deploy'))
          list.push({
            key: 'deploy',
            verb: 'deploy',
            icon: Rocket,
            title: t('palette.action.deploy', { name: hit.slug }),
            meta: t('palette.scope.deploy.meta'),
            run: () => go(`/applications?app=${encodeURIComponent(hit.slug)}&deploy=1`),
          });
        list.push({
          key: 'versions',
          verb: 'versions',
          icon: History,
          title: t('palette.action.versions', { name: hit.slug }),
          meta: t('palette.action.versions.meta'),
          run: () => go(`/applications?app=${encodeURIComponent(hit.slug)}&tab=versions`),
        });
        break;
      case 'running':
        list.push({
          key: 'logs',
          verb: 'logs',
          icon: ScrollText,
          title: t('palette.action.logs', { name: `${hit.title}@${hit.target}` }),
          meta: t('palette.action.logs.meta'),
          run: () => go(`/apps?app=${hit.id}`),
        });
        if (can('act.restart'))
          list.push({
            key: 'restart',
            verb: 'restart',
            icon: RotateCw,
            title: t('palette.action.restart', { name: `${hit.title}@${hit.target}` }),
            meta: t('palette.action.restart.meta'),
            confirm: t('palette.action.restart.confirm'),
            run: async () => {
              if (await call(`/api/apps/${hit.id}/restart`, { method: 'POST' })) {
                toast({ title: t('palette.toast.restarted', { name: hit.title }), tone: 'accent' });
                // The restart publishes its progress on the application's stream.
                go(`/apps?app=${hit.id}`);
              } else {
                onOpenChange(false);
              }
            },
          });
        break;
      case 'monitor':
        if (can('act.probe'))
          list.push({
            key: 'probe',
            verb: 'probe',
            icon: Play,
            title: t('palette.action.probe', { name: hit.title }),
            meta: t('palette.action.probe.meta'),
            run: async () => {
              onOpenChange(false);
              if (await call(`/api/monitors/${hit.id}/check`, { method: 'POST' }))
                toast({ title: t('palette.toast.probed', { name: hit.title }), tone: 'accent' });
            },
          });
        if (can('act.pause'))
          list.push(
            hit.enabled
              ? {
                  key: 'pause',
                  verb: 'pause',
                  icon: Pause,
                  title: t('palette.action.pause', { name: hit.title }),
                  meta: t('palette.action.pause.meta'),
                  run: () => toggleMonitor(hit, false),
                }
              : {
                  key: 'resume',
                  verb: 'resume',
                  icon: Play,
                  title: t('palette.action.resume', { name: hit.title }),
                  meta: t('palette.action.resume.meta'),
                  run: () => toggleMonitor(hit, true),
                },
          );
        if (can('act.editMonitor'))
          list.push({
            key: 'edit',
            verb: 'edit',
            icon: Pencil,
            title: t('palette.action.edit', { name: hit.title }),
            meta: t('palette.action.edit.meta'),
            run: () => go(`/monitors?monitor=${hit.id}&edit=1`),
          });
        break;
      default:
        break;
    }
    return list;
  }

  async function toggleMonitor(hit: Extract<SearchHit, { kind: 'monitor' }>, enabled: boolean) {
    onOpenChange(false);
    const done = await call(`/api/monitors/${hit.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (done) {
      toast({
        title: enabled
          ? t('palette.toast.resumed', { name: hit.title })
          : t('palette.toast.paused', { name: hit.title }),
      });
      router.refresh();
    }
  }

  function perform(action: Action) {
    if (action.confirm) {
      if (!focus) setSaved(raw);
      setConfirming(action);
      setRaw('');
      return;
    }
    void action.run();
  }

  function enterFocus(hit: SearchHit) {
    setSaved(raw);
    setFocus(hit);
    setRaw('');
  }

  /** Back from the sub-view to the list, with the previous input. */
  function leaveSubview() {
    setFocus(null);
    setConfirming(null);
    setRaw(saved);
  }

  async function testAllTargets() {
    onOpenChange(false);
    const response = await fetch('/api/targets', { cache: 'no-store' });
    if (!response.ok) return;
    const { items } = (await response.json()) as { items: Array<{ id: string }> };
    const results = await Promise.all(
      items.map((target) =>
        fetch(`/api/targets/${target.id}/preflight`, { method: 'POST' }).then((r) => r.ok),
      ),
    );
    const count = results.filter(Boolean).length;
    toast({
      title: t('palette.toast.preflight', { count }),
      description: t('palette.toast.preflight.detail'),
      tone: 'accent',
      action: { label: t('palette.toast.preflight.follow'), href: '/targets' },
    });
  }

  const items: Item[] = [];
  const actionItem = (action: Action, hit: SearchHit, group: Group): Item => ({
    id: `action-${hit.kind}-${hit.id}-${action.key}`,
    group,
    icon: action.icon,
    title: action.title,
    meta: action.meta,
    verb: action.verb === 'open' ? 'open' : 'run',
    words: '',
    isCommand: true,
    perform: () => perform(action),
  });

  if (confirming) {
    // The confirmation, alone on screen: Enter gives it, Escape or "Cancel" withdraws it.
    items.push(
      {
        id: 'confirm-yes',
        group: 'actions',
        icon: TriangleAlert,
        title: t('palette.confirm.yes', { action: confirming.title }),
        meta: confirming.confirm ?? '',
        verb: 'run',
        words: '',
        isCommand: true,
        perform: () => {
          const action = confirming;
          setConfirming(null);
          void action.run();
        },
      },
      {
        id: 'confirm-no',
        group: 'actions',
        icon: ChevronRight,
        title: t('palette.confirm.no'),
        meta: '',
        verb: 'run',
        words: '',
        isCommand: true,
        perform: leaveSubview,
      },
    );
  } else if (focus) {
    for (const action of actionsOf(focus)) {
      if (query === '' || matchScore(query, [action.title], [action.meta]) > 0)
        items.push(actionItem(action, focus, 'actions'));
    }
  } else if (scope === 'deploy') {
    for (const hit of hits) {
      if (hit.kind !== 'application') continue;
      items.push({
        id: `deploy-${hit.id}`,
        group: 'objects',
        icon: Boxes,
        title: hit.title,
        meta: [hit.slug, hit.version ? `v${hit.version}` : null, t('palette.scope.deploy.meta')]
          .filter(Boolean)
          .join(' · '),
        verb: 'open',
        words: `${hit.title} ${hit.slug}`,
        isCommand: false,
        perform: () => go(`/applications?app=${encodeURIComponent(hit.slug)}&deploy=1`),
      });
    }
  } else if (usableVerbs.length > 0 && !commandsOnly) {
    // "restart umami": this verb's actions on the found objects.
    for (const hit of hits) {
      for (const action of actionsOf(hit)) {
        if (action.verb !== 'open' && usableVerbs.includes(action.verb))
          items.push(actionItem(action, hit, 'actions'));
      }
    }
  } else {
    const command = (
      key: CommandKey,
      item: Omit<Item, 'id' | 'group' | 'isCommand'>,
      group: Item['group'],
    ) => {
      if (can(key)) items.push({ ...item, id: `cmd-${key}-${item.title}`, group, isCommand: true });
    };

    if (query === '' && !commandsOnly) {
      for (const recent of recents) {
        items.push({
          id: `recent-${recent.kind}-${recent.id}`,
          group: 'recent',
          icon: KIND_ICON[recent.kind] ?? Clock,
          title: recent.title,
          meta: recent.meta,
          verb: 'open',
          words: '',
          isCommand: false,
          perform: () => go(recent.href),
        });
      }
    }

    command(
      'deploy',
      {
        icon: Rocket,
        title: t('palette.cmd.deploy'),
        meta: t('palette.cmd.deploy.meta'),
        verb: 'run',
        words: 'deploy deployer',
        perform: () => {
          setRaw('');
          onScopeChange('deploy');
        },
      },
      'suggestions',
    );
    command(
      'testTargets',
      {
        icon: RefreshCw,
        title: t('palette.cmd.testTargets'),
        meta: t('palette.cmd.testTargets.meta'),
        verb: 'run',
        words: 'preflight ssh',
        perform: () => void testAllTargets(),
      },
      'suggestions',
    );
    command(
      'newApp',
      {
        icon: Plus,
        title: t('palette.cmd.newApp'),
        meta: t('palette.cmd.newApp.meta'),
        verb: 'open',
        words: 'appspec json',
        perform: () => go('/applications?add=new'),
      },
      'suggestions',
    );
    command(
      'newTarget',
      {
        icon: ServerCog,
        title: t('palette.cmd.newTarget'),
        meta: t('palette.cmd.newTarget.meta'),
        verb: 'open',
        words: 'ssh',
        perform: () => go('/targets?add=new'),
      },
      'suggestions',
    );

    for (const section of sections) {
      items.push({
        id: `goto-${section.key}`,
        group: 'goto',
        icon: SECTION_ICON[section.key],
        title: t(`nav.${section.key}`),
        meta: section.shortcut ? t('palette.goto.meta', { key: section.shortcut }) : section.href,
        verb: 'open',
        words: section.href,
        isCommand: false,
        perform: () => go(section.href),
      });
    }

    // The settings' tabs, only when they are searched for: at rest, ten more rows
    // would drown "Go to".
    if (can('settings') && query !== '') {
      for (const group of SETTINGS_GROUPS) {
        for (const settingsSection of groupSections(group)) {
          items.push({
            id: `settings-${settingsSection.id}`,
            group: 'goto',
            icon: SlidersHorizontal,
            title: ts(`section.${settingsSection.id}.label`),
            meta: t('palette.settings.meta', { group: ts(`group.${group.id}.label`) }),
            verb: 'open',
            words: `${ts(`section.${settingsSection.id}.title`)} ${ts(`section.${settingsSection.id}.short`)} parametres settings`,
            isCommand: false,
            perform: () => go(settingsSection.href),
          });
        }
      }
    }

    for (const hit of hits) {
      // → only makes sense for an object that has something other than "Open" to offer.
      items.push(objectItem(hit, t, () => open_(hit), actionsOf(hit).length > 1));
    }

    // The search continued where it fully belongs.
    if (query !== '' && !commandsOnly) {
      if (can('searchRuns'))
        items.push({
          id: 'search-runs',
          group: 'elsewhere',
          icon: Rocket,
          title: t('palette.search.runs', { query }),
          meta: t('palette.search.runs.meta'),
          verb: 'open',
          words: '',
          isCommand: false,
          perform: () => go(`/deployments?q=${encodeURIComponent(query)}`),
        });
      if (can('searchLogs'))
        items.push({
          id: 'search-logs',
          group: 'elsewhere',
          icon: BookOpen,
          title: t('palette.search.logs', { query }),
          meta: t('palette.search.logs.meta'),
          verb: 'open',
          words: '',
          isCommand: false,
          perform: () => go(`/admin/logs?q=${encodeURIComponent(query)}`),
        });
    }

    if (can('theme')) {
      const next: ThemeChoice[] =
        theme === 'dark'
          ? ['light', 'system']
          : theme === 'light'
            ? ['dark', 'system']
            : ['dark', 'light'];
      for (const choice of next) {
        command(
          'theme',
          {
            icon: choice === 'dark' ? Moon : choice === 'light' ? Sun : SunMoon,
            title: t(`palette.cmd.theme.${choice}`),
            meta: t('palette.cmd.theme.meta'),
            verb: 'run',
            words: 'theme dark light sombre clair',
            perform: () => {
              applyTheme(choice);
              onOpenChange(false);
            },
          },
          'preferences',
        );
      }
    }
    command(
      'language',
      {
        icon: Languages,
        title: t('palette.cmd.language'),
        meta: t('palette.cmd.language.meta'),
        verb: 'open',
        words: 'locale i18n',
        perform: () => go('/admin/settings/regional'),
      },
      'preferences',
    );
    command(
      'shortcuts',
      {
        icon: Keyboard,
        title: t('palette.cmd.shortcuts'),
        meta: t('palette.cmd.shortcuts.meta'),
        verb: 'open',
        words: 'shortcuts keyboard raccourcis',
        perform: onShowShortcuts,
      },
      'preferences',
    );
  }

  const visible = items.filter((item) => {
    if (commandsOnly && !item.isCommand) return false;
    // Already filtered: by the server (objects), by the verb (actions), by their
    // nature (recent ones).
    if (
      item.group === 'objects' ||
      item.group === 'actions' ||
      item.group === 'recent' ||
      item.group === 'elsewhere'
    )
      return true;
    return query === '' || matchScore(query, [item.title], [item.meta, item.words]) > 0;
  });

  const activeItem = visible.find((item) => item.id === active) ?? visible[0];
  const empty = visible.length === 0 && !searching && raw.trim() !== '';

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(next) => {
        // Escape in a sub-view (an object's actions, confirmation) goes back to the list
        // instead of closing the palette.
        if (!next && (focus || confirming)) {
          leaveSubview();
          return;
        }
        onOpenChange(next);
      }}
      label={t('palette.label')}
      shouldFilter={false}
      loop
      value={active}
      onValueChange={setActive}
      overlayClassName="scrim blur !z-[94]"
      contentClassName="cmdk"
    >
      <div className="cmdk-in">
        <Search aria-hidden className="!size-[18px] text-text-3" />
        {scope === 'deploy' && !focus && !confirming ? (
          <span className="cmdk-scope">{t('palette.scope.deploy')} ›</span>
        ) : null}
        {focus ? <span className="cmdk-scope">{titleOf(focus)} ›</span> : null}
        {confirming ? <span className="cmdk-scope">{t('palette.confirm.scope')} ›</span> : null}
        <Command.Input
          value={raw}
          onValueChange={setRaw}
          placeholder={
            confirming
              ? confirming.title
              : focus
                ? t('palette.focus.placeholder')
                : scope === 'deploy'
                  ? t('palette.scope.deploy.placeholder')
                  : t('palette.placeholder')
          }
          aria-label={t('palette.label')}
          onKeyDown={(event) => {
            const input = event.currentTarget;
            const atEnd = input.selectionStart === input.value.length;
            if (event.key === 'ArrowRight' && atEnd && !focus && !confirming && activeItem?.hit) {
              event.preventDefault();
              enterFocus(activeItem.hit);
              return;
            }
            if (
              (focus || confirming) &&
              ((event.key === 'ArrowLeft' && raw === '') ||
                (event.key === 'Backspace' && raw === ''))
            ) {
              event.preventDefault();
              event.stopPropagation();
              leaveSubview();
              return;
            }
            if (event.key === 'Backspace' && raw === '' && scope !== null) onScopeChange(null);
          }}
        />
        <Kbd>esc</Kbd>
      </div>
      <Command.List className="cmdk-list">
        {GROUP_ORDER.map((group) => {
          const inGroup = visible.filter((item) => item.group === group);
          if (inGroup.length === 0) return null;
          return (
            <Command.Group key={group} heading={t(GROUP_LABEL[group])} className="cmdk-group">
              {inGroup.map((item) => (
                <Command.Item
                  key={item.id}
                  value={item.id}
                  onSelect={item.perform}
                  className="cmdk-item"
                >
                  <span className="ico">
                    <item.icon aria-hidden />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{item.title}</span>
                    <span className="meta truncate">{item.meta}</span>
                  </span>
                  <span className="go">
                    {item.verb === 'open' ? t('palette.verb.open') : t('palette.verb.run')}
                    <Kbd>↵</Kbd>
                    {item.hit ? (
                      <>
                        <span className="text-text-3">·</span>
                        {t('palette.verb.actions')}
                        <Kbd>→</Kbd>
                      </>
                    ) : null}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          );
        })}
        {empty ? (
          <div className="flex flex-col items-center gap-1.5 px-4 py-9 text-center">
            <Search aria-hidden className="!size-5 text-text-3" />
            <span className="t-sm font-semibold">
              {t('palette.empty.title', { query: raw.trim() })}
            </span>
            <span className="t-cap max-w-[52ch] text-text-3">{t('palette.empty.hint')}</span>
          </div>
        ) : null}
        {searching && visible.length === 0 ? (
          <div className="px-4 py-9 text-center t-cap text-text-3">{t('palette.searching')}</div>
        ) : null}
      </Command.List>
      <div className="cmdk-foot">
        <span>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> {t('palette.foot.navigate')}
        </span>
        <span>
          <Kbd>↵</Kbd> {t('palette.foot.open')}
        </span>
        <span>
          <Kbd>→</Kbd> {t('palette.foot.actions')}
        </span>
        <span>
          <Kbd>›</Kbd> {t('palette.foot.commands')}
        </span>
        <span className="ml-auto">
          <Kbd>esc</Kbd> {focus || confirming ? t('palette.foot.back') : t('palette.foot.close')}
        </span>
      </div>
    </Command.Dialog>
  );
}

/** A verb only serves if one of its actions is allowed; "logs" and "versions" always are. */
function allowedVerb(verb: PaletteVerb, can: (key: CommandKey) => boolean): boolean {
  switch (verb) {
    case 'test':
      return can('act.test');
    case 'edit':
      return can('act.editTarget') || can('act.editMonitor');
    case 'deploy':
      return can('act.deploy');
    case 'restart':
      return can('act.restart');
    case 'probe':
      return can('act.probe');
    case 'pause':
    case 'resume':
      return can('act.pause');
    case 'logs':
    case 'versions':
      return true;
  }
}

function hrefOf(hit: SearchHit): string {
  switch (hit.kind) {
    case 'target':
      return `/targets?target=${hit.id}`;
    case 'application':
      return `/applications?app=${hit.id}`;
    case 'running':
      return `/apps?app=${hit.id}`;
    case 'deployment':
      return `/deployments?run=${hit.id}`;
    case 'monitor':
      return `/monitors?monitor=${hit.id}`;
    case 'domain':
      return `/domains?domain=${hit.id}`;
    case 'role':
      return `/admin/roles?role=${encodeURIComponent(hit.key)}`;
    case 'template':
      return `/catalog?template=${encodeURIComponent(hit.id)}`;
  }
}

function titleOf(hit: SearchHit): string {
  switch (hit.kind) {
    case 'deployment':
      return `#${hit.number} ${hit.title} v${hit.version}`;
    case 'running':
      return `${hit.title}@${hit.target}`;
    default:
      return hit.title;
  }
}

function metaOf(hit: SearchHit, t: Translate<(typeof chrome)['fr']>): string {
  switch (hit.kind) {
    case 'target':
      return `${t('palette.kind.target')} · ${hit.host}`;
    case 'application':
      return [t('palette.kind.application'), hit.slug, hit.version ? `v${hit.version}` : null]
        .filter(Boolean)
        .join(' · ');
    case 'running':
      return `${t('palette.kind.running')} · ${t(`palette.health.${hit.health as 'healthy'}`)}`;
    case 'deployment':
      return `${t('palette.kind.deployment')} · ${hit.target}`;
    case 'monitor':
      return `${t('palette.kind.monitor')} · ${hit.type}${hit.enabled ? '' : ` · ${t('palette.monitor.paused')}`}`;
    case 'domain':
      return `${t('palette.kind.domain')} · ${hit.application}`;
    case 'role':
      return `${t('palette.kind.role')} · ${hit.key}`;
    case 'template':
      return `${t('palette.kind.template')} · ${hit.summary}`;
  }
}

function objectItem(
  hit: SearchHit,
  t: Translate<(typeof chrome)['fr']>,
  open: () => void,
  withActions: boolean,
): Item {
  return {
    id: `${hit.kind}-${hit.id}`,
    group: 'objects',
    icon: KIND_ICON[hit.kind],
    title: titleOf(hit),
    meta: metaOf(hit, t),
    verb: 'open',
    words: '',
    isCommand: false,
    perform: open,
    ...(withActions ? { hit } : {}),
  };
}
