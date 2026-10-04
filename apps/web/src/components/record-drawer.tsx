'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { DrawerBody, Drawer } from '@/components/ui/drawer';
import { Skeleton } from '@/components/ui/skeleton';
import { Tab, Tabs } from '@/components/ui/tabs';
import { neighbour, selectionFrom } from '@/lib/drawer-url';

/**
 * An object's record — an application, a target, a probe — in a drawer, on top
 * of its list. No more separate page: one opens, reads, acts, closes, and the
 * list has not moved.
 *
 * What is already on the row shows right away (the "Overview" tab); the rest —
 * history, secrets, workloads… — is rendered by the server, because it is the
 * one reading the database. The selection therefore lives in the URL and opens
 * through a **navigation** (`router.push`), not through a mere `pushState`: the
 * page reads itself again with `?app=blog`, and renders the record with it.
 * Meanwhile, the drawer is already open on what we know.
 *
 * The current tab (`tab`) and the edit mode (`edit`) follow the URL without
 * reading the page again: a record can be shared, reloaded, at the same place.
 */

/** The parameters specific to an open record: they drop when changing record. */
const RECORD_PARAMS = ['tab', 'edit'];

export function useRecordSelection(
  key: string,
  ids: readonly string[],
  /** The URL may carry another identifier (an old link's UUID): brought back to the shown key. */
  resolve: (value: string) => string | null = (value) => value,
) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const raw = selectionFrom(params, key);
  const fromUrl = raw === null ? null : resolve(raw);
  const [isPending, startTransition] = React.useTransition();
  const [target, setTarget] = React.useState<string | null>(null);
  // During navigation, the drawer follows the gesture, not the URL that has not
  // changed yet: it opens, changes record or closes right away.
  const selected = isPending ? (target === null ? null : (resolve(target) ?? target)) : fromUrl;

  const go = React.useCallback(
    (
      id: string | null,
      mode: 'push' | 'replace',
      keepTab = false,
      extra: Record<string, string> = {},
    ) => {
      const next = new URLSearchParams(window.location.search);
      if (id === null) next.delete(key);
      else next.set(key, id);
      for (const param of RECORD_PARAMS) {
        if (!(keepTab && param === 'tab')) next.delete(param);
      }
      for (const [name, value] of Object.entries(extra)) next.set(name, value);
      const query = next.toString();
      const href = query === '' ? pathname : `${pathname}?${query}`;
      setTarget(id);
      startTransition(() => {
        if (mode === 'push') router.push(href as never, { scroll: false });
        else router.replace(href as never, { scroll: false });
      });
    },
    [key, pathname, router],
  );

  const previous = neighbour(ids, selected, -1);
  const following = neighbour(ids, selected, 1);

  return {
    selected,
    /** The requested record is not rendered by the server yet. */
    loading: isPending && target !== null,
    /** `extra`: what the record must open right away — `{ edit: '1' }`. */
    open: (id: string, extra?: Record<string, string>) =>
      go(id, selected === null ? 'push' : 'replace', false, extra),
    close: () => go(null, 'replace'),
    onPrevious:
      previous !== null && selected !== null ? () => go(previous, 'replace', true) : undefined,
    onNext:
      following !== null && selected !== null ? () => go(following, 'replace', true) : undefined,
  };
}

/** A parameter of the open record, read and set without reading the page again. */
export function useRecordParam(name: string): [string | null, (value: string | null) => void] {
  const params = useSearchParams();
  const value = selectionFrom(params, name);
  const set = React.useCallback(
    (next: string | null) => {
      const search = new URLSearchParams(window.location.search);
      if (next === null) search.delete(name);
      else search.set(name, next);
      const query = search.toString();
      window.history.replaceState(
        null,
        '',
        query === '' ? window.location.pathname : `${window.location.pathname}?${query}`,
      );
    },
    [name],
  );
  return [value, set];
}

export type RecordTab = {
  key: string;
  label: React.ReactNode;
  count?: React.ReactNode;
  /** `undefined`: rendered by the server, not arrived yet. */
  content: React.ReactNode | undefined;
};

/** What holds the place of a tab the server has not rendered yet. */
export function RecordSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      <Skeleton variant="text" className="w-1/3" />
      <Skeleton className="h-24 w-full" />
      <Skeleton variant="text" className="w-2/3" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

/**
 * A record's drawer: its header, its tabs, the current tab, its footer.
 * `override` replaces tabs and footer — it is the edit mode, where the form
 * brings its own body and its own buttons.
 *
 * A tab is only mounted once opened (a workloads list queries the machine), then
 * stays mounted, hidden: one finds again what one had typed there.
 */
export function RecordDrawer({
  open,
  recordKey,
  onClose,
  onPrevious,
  onNext,
  label,
  header,
  tabs,
  tabsLabel,
  footer,
  override,
}: {
  open: boolean;
  /** The shown object: changing object starts again from new tabs. */
  recordKey: string | null;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  label?: string;
  header: React.ReactNode;
  tabs: RecordTab[];
  tabsLabel: string;
  /** The current tab's footer — receives its key. */
  footer?: (tab: string) => React.ReactNode;
  override?: React.ReactNode;
}) {
  return (
    <Drawer
      open={open}
      onOpenChange={(next) => (next ? undefined : onClose())}
      onPrevious={override ? undefined : onPrevious}
      onNext={override ? undefined : onNext}
      xwide
      label={label}
    >
      {open ? (
        override ? (
          override
        ) : (
          <RecordPanes
            key={recordKey ?? ''}
            header={header}
            tabs={tabs}
            tabsLabel={tabsLabel}
            footer={footer}
          />
        )
      ) : null}
    </Drawer>
  );
}

function RecordPanes({
  header,
  tabs,
  tabsLabel,
  footer,
}: {
  header: React.ReactNode;
  tabs: RecordTab[];
  tabsLabel: string;
  footer?: (tab: string) => React.ReactNode;
}) {
  const [tabParam, setTabParam] = useRecordParam('tab');
  const active = tabs.some((tab) => tab.key === tabParam) ? tabParam! : (tabs[0]?.key ?? '');
  const [visited, setVisited] = React.useState<ReadonlySet<string>>(() => new Set([active]));
  const shown = visited.has(active) ? visited : new Set([...visited, active]);

  function select(key: string) {
    setVisited((current) => new Set([...current, key]));
    setTabParam(key === tabs[0]?.key ? null : key);
  }

  return (
    <>
      {header}
      {/* A record in one piece (a run, a running application) has no tabs. */}
      {tabs.length > 1 ? (
        <div className="dr-tabs">
          <Tabs label={tabsLabel}>
            {tabs.map((tab) => (
              <Tab
                key={tab.key}
                selected={tab.key === active}
                count={tab.count}
                onClick={() => select(tab.key)}
              >
                {tab.label}
              </Tab>
            ))}
          </Tabs>
        </div>
      ) : null}
      <DrawerBody>
        {tabs
          .filter((tab) => shown.has(tab.key))
          .map((tab) => (
            <div
              key={tab.key}
              role="tabpanel"
              hidden={tab.key !== active}
              className="flex flex-col gap-5"
            >
              {tab.content === undefined ? <RecordSkeleton /> : tab.content}
            </div>
          ))}
      </DrawerBody>
      {footer ? footer(active) : null}
    </>
  );
}
