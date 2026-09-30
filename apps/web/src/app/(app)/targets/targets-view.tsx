'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Ellipsis, Plus, RefreshCw, Search, Server } from 'lucide-react';
import type { RuntimesAvailable, TargetHealth } from '@pupitre/core';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { MicroSpark } from '@/components/spark';
import { TargetHelpDialog } from '@/components/target-help';
import { TargetLabelChip, TargetLabelList, sortedLabelEntries } from '@/components/target-label';
import { Alert } from '@/components/ui/alert';
import { RuntimePill } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { MiniGauge } from '@/components/ui/data';
import { useDrawerSelection } from '@/components/ui/drawer';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FilterChip } from '@/components/ui/filter-chip';
import { Kbd } from '@/components/ui/kbd';
import { State } from '@/components/ui/led';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { IconButton } from '@/components/ui/tooltip';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { targets as messages } from '@/i18n/messages/targets';
import { hrefWithSelection } from '@/lib/drawer-url';
import { toast } from '@/lib/toast';
import { AddTargetDrawer } from './add-target-drawer';
import { STATUS_TONE } from './status';
import type { CreatedTarget } from './target-form';
import { TargetDrawer } from './target-drawer';
import { usePreflight } from './use-preflight';

export type TargetRow = {
  id: string;
  name: string;
  description: string | null;
  host: string;
  port: number;
  sshUser: string;
  authMethod: 'key' | 'password';
  sudoMethod: 'nopasswd' | 'password';
  labels: Record<string, string>;
  runtimesAvailable: RuntimesAvailable;
  status: TargetHealth;
  /** Date courte du dernier preflight (« 30/09 14:05 »), formatée par le serveur. */
  lastCheck: string | null;
  lastCheckClock: string | null;
  testedAgo: string | null;
  measured: boolean;
  load: (number | null)[];
  loadLast: number | null;
  loadWorst: number | null;
  memory: number | null;
  disk: number | null;
  failedChecks: string[];
  error: string | null;
  portRange: { start: number; end: number };
  portsUsed: number | null;
  /** `null` : la session ne lit pas les déploiements. */
  apps: Array<{ id: string; slug: string; health: string }> | null;
  /** `null` : la session ne peut pas supprimer, le décompte n'a pas été lu. */
  deployments: { live: number; history: number } | null;
};


export type Limits = { load: number; memory: number; disk: number };

const STATUSES: TargetHealth[] = ['ok', 'degraded', 'unreachable', 'unknown'];

/** En-dessous, un champ de recherche encombre plus qu'il ne sert. */
const SEARCH_THRESHOLD = 5;

/** Ce qu'une ligne de tableau peut porter d'étiquettes sans se déformer. */
const ROW_LABEL_MAX = 3;

/** Accents et casse ignorés : on cherche « acmé » en tapant « acme ». */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/**
 * La liste des cibles et leur aperçu.
 *
 * Le filtrage est intégralement en mémoire : un parc réaliste est déjà chargé
 * en entier, et repasser par le serveur pour retirer trois lignes coûterait un
 * aller-retour par frappe. Les filtres sont reportés dans l'URL par l'API
 * History — partageables, sans relancer le rendu serveur.
 */
export function TargetsView({
  targets,
  canCreate,
  canRunPreflight,
  canEdit,
  canDelete,
  timezone,
  limits,
  initialQuery,
  initialLabels,
  initialStatus,
}: {
  targets: TargetRow[];
  canCreate: boolean;
  canRunPreflight: boolean;
  canEdit: boolean;
  canDelete: boolean;
  timezone: string;
  limits: Limits;
  initialQuery: string;
  initialLabels: string[];
  initialStatus: string;
}) {
  const router = useRouter();
  const t = useT(messages);
  const tc = useT(common);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState(initialQuery);
  const [selectedLabels, setSelectedLabels] = useState<string[]>(initialLabels);
  const [status, setStatus] = useState<string>(initialStatus);
  const [deleting, setDeleting] = useState<TargetRow | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const { run, phaseOf, isRunning } = usePreflight({ onError: setError });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    params.delete('q');
    params.delete('label');
    params.delete('status');
    const trimmed = query.trim();
    if (trimmed) params.set('q', trimmed);
    for (const pair of selectedLabels) params.append('label', pair);
    if (status) params.set('status', status);
    const search = params.toString();
    window.history.replaceState(
      null,
      '',
      search ? `${window.location.pathname}?${search}` : window.location.pathname,
    );
  }, [query, selectedLabels, status]);

  /*
   * Facettes : toutes les paires présentes dans le parc, les plus portées
   * d'abord — l'étiquette qui découpe le parc en deux est plus utile comme
   * filtre que celle qui n'en désigne qu'une machine.
   */
  const facets = useMemo(() => {
    const counts = new Map<string, { key: string; value: string; count: number }>();
    for (const target of targets) {
      for (const [key, value] of Object.entries(target.labels)) {
        const pair = `${key}=${value}`;
        const seen = counts.get(pair);
        if (seen) seen.count += 1;
        else counts.set(pair, { key, value, count: 1 });
      }
    }
    return [...counts.entries()]
      .sort(([pairA, a], [pairB, b]) => b.count - a.count || pairA.localeCompare(pairB, 'fr'))
      .map(([pair, entry]) => ({ pair, ...entry }));
  }, [targets]);

  /*
   * Deux paires de la même clé se lisent en OU, deux clés différentes en ET :
   * « (env=prod OU env=staging) ET client=acme » est exactement la question
   * qu'on se pose devant un parc.
   */
  const selectedByKey = useMemo(() => {
    const groups = new Map<string, Set<string>>();
    for (const pair of selectedLabels) {
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const key = pair.slice(0, separator);
      const group = groups.get(key) ?? new Set<string>();
      group.add(pair.slice(separator + 1));
      groups.set(key, group);
    }
    return groups;
  }, [selectedLabels]);

  const selectedPairs = useMemo(() => new Set(selectedLabels), [selectedLabels]);

  // Les cibles qui passent le filtre texte et étiquettes — avant l'état, pour
  // que les compteurs des puces d'état disent ce qu'on obtiendrait en cliquant.
  const matching = useMemo(() => {
    const needle = fold(query.trim());
    return targets.filter((target) => {
      for (const [key, values] of selectedByKey) {
        const own = target.labels[key];
        if (own === undefined || !values.has(own)) return false;
      }
      if (!needle) return true;
      const haystack = fold(
        [
          target.name,
          target.description ?? '',
          `${target.sshUser}@${target.host}:${target.port}`,
          sortedLabelEntries(target.labels)
            .map(([key, value]) => `${key}=${value}`)
            .join(' '),
        ].join(' '),
      );
      return haystack.includes(needle);
    });
  }, [targets, query, selectedByKey]);

  const visible = status ? matching.filter((target) => target.status === status) : matching;
  const drawer = useDrawerSelection(
    'target',
    visible.map((target) => target.name),
  );
  const current = targets.find((target) => target.name === drawer.selected) ?? null;
  // « Ajouter une cible » vit dans l'URL comme l'aperçu : `?add=new` l'ouvre
  // depuis un lien, la palette ou l'ancienne adresse `/targets/new`.
  const adding = useDrawerSelection('add');
  const pathname = usePathname();

  /** La cible créée : le tiroir d'ajout se ferme, son aperçu s'ouvre, prêt à tester. */
  function created(target: CreatedTarget) {
    const withoutAdd = hrefWithSelection(pathname, window.location.search, 'add', null);
    const search = withoutAdd.includes('?') ? withoutAdd.slice(withoutAdd.indexOf('?')) : '';
    window.history.replaceState(
      null,
      '',
      hrefWithSelection(pathname, search, 'target', target.name),
    );
    toast({
      title: t('toast.created', { name: target.name }),
      description: t('toast.created.detail'),
      tone: 'ok',
    });
    router.refresh();
  }

  function toggleLabel(pair: string) {
    setSelectedLabels((list) =>
      list.includes(pair) ? list.filter((item) => item !== pair) : [...list, pair],
    );
  }

  function labelTitle(pair: string, active: boolean): string {
    return active ? t('label.filter.off', { pair }) : t('label.filter.on', { pair });
  }

  function test(target: TargetRow) {
    toast({
      title: t('toast.preflight.title', { name: target.name }),
      description: t('toast.preflight.detail'),
      tone: 'accent',
    });
    void run(target.id);
  }

  function testAll() {
    const candidates = visible.filter((target) => !isRunning(target.id));
    toast({
      title: t('toast.preflightAll.title', { count: candidates.length }),
      description: t('toast.preflightAll.detail'),
      tone: 'accent',
    });
    for (const target of candidates) void run(target.id);
  }

  async function confirmDelete() {
    if (!deleting) return;
    setDeletePending(true);
    setDeleteError(null);
    const response = await fetch(`/api/targets/${deleting.id}`, { method: 'DELETE' });
    setDeletePending(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      setDeleteError(body.error?.message ?? tc('http.failure', { status: response.status }));
      return;
    }
    toast({ title: t('toast.deleted', { name: deleting.name }), tone: 'ok' });
    setDeleting(null);
    drawer.close();
    router.refresh();
  }

  const showSearch = targets.length >= SEARCH_THRESHOLD || query !== '';
  const filtering = selectedLabels.length > 0 || query.trim() !== '' || status !== '';

  return (
    <>
      <PageHeader
        title={t('page.title')}
        description={t('page.description')}
        actions={
          <>
            <TargetHelpDialog />
            {canRunPreflight && targets.length > 0 ? (
              <Button variant="secondary" onClick={testAll}>
                <RefreshCw aria-hidden />
                {t('page.testAll')}
              </Button>
            ) : null}
            {canCreate ? (
              <Button onClick={() => adding.open('new')}>
                <Plus aria-hidden />
                {t('page.add')}
              </Button>
            ) : null}
          </>
        }
      />

      {targets.length === 0 ? (
        <EmptyState
          icon={Server}
          title={t('empty.title')}
          hint={t('empty.hint')}
          action={
            canCreate ? (
              <Button onClick={() => adding.open('new')}>
                <Plus aria-hidden />
                {t('page.add')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div role="group" aria-label={t('chips.label')} className="flex flex-wrap gap-2">
            <FilterChip
              active={status === ''}
              count={matching.length}
              onClick={() => setStatus('')}
            >
              {t('chip.all')}
            </FilterChip>
            {STATUSES.map((key) => {
              const count = matching.filter((target) => target.status === key).length;
              if (count === 0 && status !== key) return null;
              return (
                <FilterChip
                  key={key}
                  active={status === key}
                  count={count}
                  onClick={() => setStatus(key)}
                >
                  {t(`chip.${key}`)}
                </FilterChip>
              );
            })}
          </div>

          {error ? <Alert variant="destructive">{error}</Alert> : null}

          <section className="card overflow-hidden">
            <div className="flex flex-wrap items-center gap-3 border-b border-border-subtle px-4 py-3">
              {showSearch ? (
                <span className="affix w-full max-w-[300px]">
                  <Search aria-hidden />
                  <input
                    type="search"
                    className="input input-sm"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('filter.placeholder')}
                    aria-label={t('filter.aria')}
                  />
                </span>
              ) : null}
              {facets.length > 0 ? (
                <span className="flex flex-wrap items-center gap-1.5">
                  {facets.map((facet) => (
                    <TargetLabelChip
                      key={facet.pair}
                      labelKey={facet.key}
                      value={facet.value}
                      active={selectedPairs.has(facet.pair)}
                      onToggle={() => toggleLabel(facet.pair)}
                      titleOf={(active) => labelTitle(facet.pair, active)}
                    />
                  ))}
                </span>
              ) : null}
              {filtering ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setQuery('');
                    setSelectedLabels([]);
                    setStatus('');
                  }}
                >
                  {t('filter.showAll')}
                </Button>
              ) : null}
              <span className="t-cap num ml-auto text-text-3" role="status">
                {filtering
                  ? t('filter.count', { count: visible.length, total: targets.length })
                  : t('filter.total', { count: targets.length })}
              </span>
            </div>

            {visible.length === 0 ? (
              <p className="t-sm px-4 py-8 text-center text-text-2">{t('filter.none')}</p>
            ) : (
              <Table label={t('page.title')}>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tc('column.target')}</TableHead>
                    <TableHead>{t('column.runtimes')}</TableHead>
                    <TableHead>{t('column.load')}</TableHead>
                    <TableHead>{tc('column.status')}</TableHead>
                    <TableHead>{t('column.lastCheck')}</TableHead>
                    <TableHead>
                      <span className="sr-only">{tc('column.actions')}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((target) => {
                    const phase = phaseOf(target.id);
                    return (
                      <TableRow
                        key={target.id}
                        interactive
                        selected={drawer.selected === target.name}
                        onClick={() => drawer.open(target.name)}
                      >
                        <TableCell className="max-w-[26rem] py-2.5">
                          <div className="flex min-w-0 flex-col gap-0.5">
                            <button
                              type="button"
                              className="cellname w-fit text-left hover:underline"
                              aria-label={t('row.preview', { name: target.name })}
                              onClick={(event) => {
                                event.stopPropagation();
                                drawer.open(target.name);
                              }}
                            >
                              {target.name}
                            </button>
                            <span className="mono text-[11.5px] text-text-3">
                              {target.sshUser}@{target.host}:{target.port}
                            </span>
                            {target.description ? (
                              <span
                                className="t-cap max-w-[300px] truncate text-text-3"
                                title={target.description}
                              >
                                {target.description}
                              </span>
                            ) : null}
                            <span onClick={(event) => event.stopPropagation()}>
                              <TargetLabelList
                                labels={target.labels}
                                max={ROW_LABEL_MAX}
                                className="mt-1"
                                onToggle={toggleLabel}
                                activePairs={selectedPairs}
                                titleOf={labelTitle}
                              />
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Runtimes runtimes={target.runtimesAvailable} />
                        </TableCell>
                        <TableCell>
                          <LoadCell target={target} limits={limits} />
                        </TableCell>
                        <TableCell>
                          <State tone={STATUS_TONE[target.status]}>
                            {t(`status.${target.status}`)}
                          </State>
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {phase ? (
                            <span className="t-cap inline-flex items-center gap-2 text-accent-text">
                              <span className="spinner" aria-hidden />
                              {phase}
                            </span>
                          ) : (
                            <span className="mono text-[12px] text-text-2">
                              {target.lastCheck ?? t('preflight.never')}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="r" onClick={(event) => event.stopPropagation()}>
                          <span className="inline-flex items-center gap-0.5">
                            {canRunPreflight ? (
                              <IconButton
                                label={t('action.test')}
                                size="icon-sm"
                                disabled={isRunning(target.id)}
                                onClick={() => test(target)}
                              >
                                <RefreshCw />
                              </IconButton>
                            ) : null}
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <IconButton label={t('row.more')} size="icon-sm">
                                  <Ellipsis />
                                </IconButton>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem asChild>
                                  <Link href={`/targets/${target.id}`}>{t('row.open')}</Link>
                                </DropdownMenuItem>
                                {canEdit ? (
                                  <DropdownMenuItem asChild>
                                    <Link href={`/targets/${target.id}/edit`}>{tc('edit')}</Link>
                                  </DropdownMenuItem>
                                ) : null}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </span>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}

            <div className="pager flex-wrap">
              <span>{t('table.timestamps', { timezone })}</span>
              <span className="ml-auto inline-flex items-center gap-1.5 max-sm:hidden">
                {t('table.hint.before')} <Kbd>↵</Kbd> {t('table.hint.after')}
              </span>
            </div>
          </section>
        </>
      )}

      {canCreate ? (
        <AddTargetDrawer
          open={adding.selected !== null}
          onClose={adding.close}
          onCreated={created}
        />
      ) : null}

      <TargetDrawer
        target={current}
        open={current !== null}
        onOpenChange={(next) => (next ? undefined : drawer.close())}
        onPrevious={drawer.onPrevious}
        onNext={drawer.onNext}
        limits={limits}
        canRunPreflight={canRunPreflight}
        canEdit={canEdit}
        canDelete={canDelete}
        testing={current ? isRunning(current.id) : false}
        onTest={() => (current ? test(current) : undefined)}
        onDelete={() => {
          setDeleteError(null);
          setDeleting(current);
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => (next ? undefined : setDeleting(null))}
        level="trace"
        title={deleting ? t('delete.title', { name: deleting.name }) : ''}
        consequences={
          deleting
            ? [
                t('delete.consequence.key'),
                t('delete.consequence.machine', { host: deleting.host }),
                t('delete.consequence.audit'),
              ]
            : []
        }
        confirmLabel={t('delete.confirm')}
        pendingLabel={tc('deleting')}
        pending={deletePending}
        error={deleteError}
        onConfirm={confirmDelete}
      />
    </>
  );
}

export function Runtimes({ runtimes }: { runtimes: RuntimesAvailable }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <RuntimePill
        name="Docker"
        version={runtimes.docker.version}
        available={runtimes.docker.available}
      />
      <RuntimePill
        name="K3s"
        version={runtimes.k3s.version}
        available={runtimes.k3s.available && runtimes.k3s.clusterReady}
      />
    </span>
  );
}

/**
 * La charge sur 24 h : la forme de la courbe, puis la mémoire et le disque.
 * Une machine qui ne répond plus le dit en rouge à la place des jauges ; une
 * machine jamais relevée le dit en toutes lettres.
 */
function LoadCell({ target, limits }: { target: TargetRow; limits: Limits }) {
  const t = useT(messages);
  if (!target.measured) return <span className="t-cap text-text-3">{t('load.none')}</span>;
  const hot = target.status === 'degraded' || (target.loadWorst ?? 0) >= limits.load;
  return (
    <span className="flex items-center gap-4">
      <MicroSpark
        values={target.load}
        width={80}
        height={24}
        max={100}
        tone={hot ? 'var(--warn)' : 'var(--gauge-fill)'}
      />
      {target.status === 'unreachable' ? (
        <span className="t-cap text-danger-text">
          {t('load.silent', { time: target.lastCheckClock ?? '—' })}
        </span>
      ) : (
        <span className="flex flex-col gap-1">
          {target.memory !== null ? (
            <MiniGauge
              label={t('gauge.memory')}
              percent={target.memory}
              tone={target.memory >= limits.memory ? 'warn' : undefined}
            />
          ) : null}
          {target.disk !== null ? (
            <MiniGauge
              label={t('gauge.disk')}
              percent={target.disk}
              tone={target.disk >= limits.disk ? 'warn' : undefined}
            />
          ) : null}
        </span>
      )}
    </span>
  );
}
