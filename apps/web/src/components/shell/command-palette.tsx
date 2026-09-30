'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Command } from 'cmdk';
import {
  Boxes,
  Keyboard,
  Languages,
  Moon,
  Plus,
  Radar,
  RefreshCw,
  Rocket,
  Search,
  Server,
  ServerCog,
  Sun,
  SunMoon,
  type LucideIcon,
} from 'lucide-react';
import type { Translate } from '@pupitre/core';
import type { SearchHit } from '@/app/api/search/route';
import { Kbd } from '@/components/ui/kbd';
import { useT } from '@/i18n/client';
import { chrome } from '@/i18n/messages/chrome';
import { parsePaletteQuery, type CommandKey } from '@/lib/navigation';
import { applyTheme, parseTheme, type ThemeChoice } from '@/lib/theme';
import { toast } from '@/lib/toast';
import { SECTION_ICON } from './section-icons';
import type { PaletteScope, ShellSection } from './shell-provider';

/**
 * Palette ⌘K — 640 px, à 96 px du haut, entrée `pp-cmdk`.
 *
 * Quatre groupes : Suggestions, Aller à, Objets, Préférences ; un groupe vide
 * est masqué. Le préfixe `›` ne garde que les commandes. Les objets viennent
 * de `GET /api/search`, qui ne lit que ce que la session a le droit de voir ;
 * les commandes et les sections arrivent déjà filtrées par la coquille. Une
 * commande interdite n'apparaît donc pas — ni grisée, ni expliquée.
 *
 * Le filtrage est fait ici plutôt que par cmdk : le préfixe `›`, les objets
 * déjà filtrés par le serveur et le masquage des groupes vides ne se disent
 * pas avec son filtre flou.
 */

type Item = {
  id: string;
  group: 'suggestions' | 'goto' | 'objects' | 'preferences';
  icon: LucideIcon;
  title: string;
  meta: string;
  verb: 'open' | 'run';
  words: string;
  isCommand: boolean;
  perform: () => void;
};

const GROUP_ORDER = ['suggestions', 'goto', 'objects', 'preferences'] as const;
const GROUP_LABEL = {
  suggestions: 'palette.group.suggestions',
  goto: 'palette.group.goto',
  objects: 'palette.group.objects',
  preferences: 'palette.group.preferences',
} as const;

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
  const router = useRouter();
  const [raw, setRaw] = React.useState('');
  const [found, setFound] = React.useState<{ key: string; items: SearchHit[] }>({
    key: '',
    items: [],
  });
  const [searching, setSearching] = React.useState(false);
  // Lu une fois par ouverture : la coquille remonte la palette à chaque fois.
  const [theme] = React.useState<ThemeChoice>(() => {
    if (typeof document === 'undefined') return 'system';
    const root = document.documentElement.classList;
    return parseTheme(root.contains('dark') ? 'dark' : root.contains('light') ? 'light' : null);
  });
  const { query, commandsOnly } = parsePaletteQuery(raw);
  const searchKey = `${scope ?? ''}|${query}`;
  const idle = commandsOnly || (scope === null && query === '');
  // Les résultats d'une saisie précédente ne s'affichent jamais sous la suivante.
  const hits = !idle && found.key === searchKey ? found.items : [];

  // Recherche d'objets, avec un léger délai pour ne pas interroger à chaque frappe.
  React.useEffect(() => {
    if (!open || idle) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      const params = new URLSearchParams({ q: query });
      if (scope === 'deploy') params.set('kind', 'application');
      try {
        const response = await fetch(`/api/search?${params}`, { signal: controller.signal });
        if (response.ok) {
          const { items } = (await response.json()) as { items: SearchHit[] };
          setFound({ key: searchKey, items });
        }
      } catch {
        // Recherche abandonnée ou réseau coupé : la palette garde ses commandes.
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 140);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [open, idle, query, scope, searchKey]);

  function go(href: string) {
    onOpenChange(false);
    router.push(href as never);
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

  if (scope === 'deploy') {
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
  } else {
    const command = (
      key: CommandKey,
      item: Omit<Item, 'id' | 'group' | 'isCommand'>,
      group: Item['group'],
    ) => {
      if (commands.includes(key))
        items.push({ ...item, id: `cmd-${key}-${item.title}`, group, isCommand: true });
    };
    command(
      'deploy',
      {
        icon: Rocket,
        title: t('palette.cmd.deploy'),
        meta: t('palette.cmd.deploy.meta'),
        verb: 'run',
        words: 'deploy',
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
        perform: () => go('/applications/new'),
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
        perform: () => go('/targets/new'),
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

    for (const hit of hits) {
      items.push(objectItem(hit, t, go));
    }

    if (commands.includes('theme')) {
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
            words: 'theme dark light',
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
        perform: () => go('/admin/settings/regionalisation'),
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
        words: 'shortcuts keyboard',
        perform: onShowShortcuts,
      },
      'preferences',
    );
  }

  const needle = query.toLowerCase();
  const visible = items.filter((item) => {
    if (commandsOnly && !item.isCommand) return false;
    if (item.group === 'objects') return true; // déjà filtrés par le serveur
    return (
      needle === '' || `${item.title} ${item.meta} ${item.words}`.toLowerCase().includes(needle)
    );
  });

  const empty = visible.length === 0 && !searching && raw.trim() !== '';

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label={t('palette.label')}
      shouldFilter={false}
      loop
      overlayClassName="scrim blur !z-[94]"
      contentClassName="cmdk"
    >
      <div className="cmdk-in">
        <Search aria-hidden className="!size-[18px] text-text-3" />
        {scope === 'deploy' ? (
          <span className="cmdk-scope">{t('palette.scope.deploy')} ›</span>
        ) : null}
        <Command.Input
          value={raw}
          onValueChange={setRaw}
          placeholder={
            scope === 'deploy' ? t('palette.scope.deploy.placeholder') : t('palette.placeholder')
          }
          aria-label={t('palette.label')}
          onKeyDown={(event) => {
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
          <Kbd>›</Kbd> {t('palette.foot.commands')}
        </span>
        <span className="ml-auto">
          <Kbd>esc</Kbd> {t('palette.foot.close')}
        </span>
      </div>
    </Command.Dialog>
  );
}

function objectItem(
  hit: SearchHit,
  t: Translate<(typeof chrome)['fr']>,
  go: (href: string) => void,
): Item {
  switch (hit.kind) {
    case 'target':
      return {
        id: `target-${hit.id}`,
        group: 'objects',
        icon: Server,
        title: hit.title,
        meta: `${t('palette.kind.target')} · ${hit.host}`,
        verb: 'open',
        words: hit.host,
        isCommand: false,
        perform: () => go(`/targets/${hit.id}`),
      };
    case 'application':
      return {
        id: `application-${hit.id}`,
        group: 'objects',
        icon: Boxes,
        title: hit.title,
        meta: [t('palette.kind.application'), hit.slug, hit.version ? `v${hit.version}` : null]
          .filter(Boolean)
          .join(' · '),
        verb: 'open',
        words: hit.slug,
        isCommand: false,
        perform: () => go(`/applications/${hit.id}`),
      };
    case 'deployment':
      return {
        id: `deployment-${hit.id}`,
        group: 'objects',
        icon: Rocket,
        title: `${hit.title} v${hit.version}`,
        meta: `${t('palette.kind.deployment')} · ${hit.target}`,
        verb: 'open',
        words: hit.target,
        isCommand: false,
        perform: () => go(`/deployments/${hit.id}`),
      };
    case 'monitor':
      return {
        id: `monitor-${hit.id}`,
        group: 'objects',
        icon: Radar,
        title: hit.title,
        meta: `${t('palette.kind.monitor')} · ${hit.type}`,
        verb: 'open',
        words: hit.type,
        isCommand: false,
        perform: () => go(`/monitors/${hit.id}`),
      };
  }
}
