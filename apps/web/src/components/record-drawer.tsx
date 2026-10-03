'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { DrawerBody, Drawer } from '@/components/ui/drawer';
import { Skeleton } from '@/components/ui/skeleton';
import { Tab, Tabs } from '@/components/ui/tabs';
import { neighbour, selectionFrom } from '@/lib/drawer-url';

/**
 * La fiche d'un objet — une application, une cible, une sonde — dans un
 * tiroir, par-dessus sa liste. Plus de page à part : on ouvre, on lit, on
 * agit, on referme, et la liste n'a pas bougé.
 *
 * Ce qui est déjà sur la ligne s'affiche tout de suite (l'onglet « Aperçu ») ;
 * le reste — historique, secrets, charges… — est rendu par le serveur, parce
 * que c'est lui qui lit la base. La sélection vit donc dans l'URL et s'ouvre
 * par une **navigation** (`router.push`), pas par un simple `pushState` : la
 * page se relit avec `?app=blog`, et rend la fiche avec elle. Pendant ce
 * temps, le tiroir est déjà ouvert sur ce qu'on sait.
 *
 * L'onglet courant (`tab`) et le mode modification (`edit`) suivent l'URL
 * sans relire la page : une fiche se partage, se recharge, au même endroit.
 */

/** Les paramètres propres à une fiche ouverte : ils tombent quand on en change. */
const RECORD_PARAMS = ['tab', 'edit'];

export function useRecordSelection(
  key: string,
  ids: readonly string[],
  /** L'URL peut porter un autre identifiant (l'UUID d'un ancien lien) : on le ramène à la clé affichée. */
  resolve: (value: string) => string | null = (value) => value,
) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const raw = selectionFrom(params, key);
  const fromUrl = raw === null ? null : resolve(raw);
  const [isPending, startTransition] = React.useTransition();
  const [target, setTarget] = React.useState<string | null>(null);
  // Pendant la navigation, le tiroir suit le geste, pas l'URL qui n'a pas
  // encore changé : il s'ouvre, change de fiche ou se ferme tout de suite.
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
    /** La fiche demandée n'est pas encore rendue par le serveur. */
    loading: isPending && target !== null,
    /** `extra` : ce que la fiche doit ouvrir d'emblée — `{ edit: '1' }`. */
    open: (id: string, extra?: Record<string, string>) =>
      go(id, selected === null ? 'push' : 'replace', false, extra),
    close: () => go(null, 'replace'),
    onPrevious:
      previous !== null && selected !== null ? () => go(previous, 'replace', true) : undefined,
    onNext:
      following !== null && selected !== null ? () => go(following, 'replace', true) : undefined,
  };
}

/** Un paramètre de la fiche ouverte, lu et posé sans relire la page. */
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
  /** `undefined` : rendu par le serveur, pas encore arrivé. */
  content: React.ReactNode | undefined;
};

/** Ce qui tient la place d'un onglet que le serveur n'a pas encore rendu. */
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
 * Le tiroir d'une fiche : son en-tête, ses onglets, l'onglet courant, son
 * pied. `override` remplace onglets et pied — c'est le mode modification, où
 * le formulaire apporte son propre corps et ses propres boutons.
 *
 * Un onglet n'est monté qu'une fois ouvert (une liste de charges interroge la
 * machine), puis reste monté, caché : on retrouve ce qu'on y avait saisi.
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
  /** L'objet affiché : changer d'objet repart d'onglets neufs. */
  recordKey: string | null;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  label?: string;
  header: React.ReactNode;
  tabs: RecordTab[];
  tabsLabel: string;
  /** Le pied de l'onglet courant — reçoit sa clé. */
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
      {/* Une fiche d'un seul tenant (un run, une application en marche) n'a pas d'onglets. */}
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
