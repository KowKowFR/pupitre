'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import {
  CircleAlert,
  Ellipsis,
  Pause,
  Pencil,
  Play,
  Plus,
  Radar,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { formatCadence, parseMonitorPause, type MonitorType, type Translate } from '@pupitre/core';
import { EmptyState } from '@/components/empty-state';
import { RecordDrawer, useRecordParam, useRecordSelection } from '@/components/record-drawer';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FieldValue } from '@/components/ui/data';
import { Drawer, DrawerFooter, DrawerHeader, DrawerSection } from '@/components/ui/drawer';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { State, type Tone } from '@/components/ui/led';
import { IconButton } from '@/components/ui/tooltip';
import { useLanguage, useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { monitors as messages } from '@/i18n/messages/monitors';
import { servers } from '@/i18n/messages/servers';
import { formatSince } from '@/app/(app)/apps/apps-table';
import { formatNumber, type FormatSettings } from '@/lib/format';
import { toast } from '@/lib/toast';
import { MonitorForm, type AdoptableApp, type TypeOption } from './monitor-form';
import type { MonitorRecord } from './record/record';
import { LatencySparkline, OutcomeStrip, StripAxis } from './monitor-charts';

/**
 * L'écran des sondes.
 *
 * Trois principes de lecture, tous tenus ici :
 *
 *   — l'état se lit **à la forme autant qu'à la couleur** : un voyant et un mot,
 *     et chaque barre de la frise nomme son verdict au survol ;
 *   — une sonde **jamais exécutée le dit**, au lieu d'afficher 0 % ;
 *   — un taux dit **sur quelle fenêtre** il porte et **combien de mesures** le
 *     composent : « 100 % sur 3 mesures » n'est pas « 100 % sur 1 440 ».
 *
 * Et le formulaire ne connaît aucun type de sonde : il se construit à partir du
 * catalogue que le serveur lui envoie.
 */

export type MonitorRow = {
  id: string;
  name: string;
  type: MonitorType;
  typeLabel: string;
  target: string;
  targetLink: string | null;
  intervalSeconds: number;
  failureThreshold: number;
  recoveryThreshold: number;
  enabled: boolean;
  pausedReason: string | null;
  applicationId: string | null;
  hasWebhook: boolean;
  status: 'unknown' | 'healthy' | 'unhealthy' | 'unreachable';
  lastOutcome: 'unknown' | 'healthy' | 'unhealthy' | 'unreachable' | null;
  consecutiveFailures: number;
  lastCheckedAt: string | null;
  lastLatencyMs: number | null;
  lastDetail: string | null;
  neverRan: boolean;
  uptime24h: { hours: number; samples: number; up: number; ratio: number | null; label: string };
  uptime7d: { hours: number; samples: number; up: number; ratio: number | null; label: string };
  recent: Array<{ at: string; latencyMs: number | null; outcome: string }>;
  openIncidentSince: string | null;
};

export type { AdoptableApp, TypeOption };

type ApiError = { error?: { message?: string } };

type Messages = Translate<(typeof messages)['fr']>;

const STATUS_TONE: Record<MonitorRow['status'], Tone> = {
  healthy: 'ok',
  unhealthy: 'warn',
  unreachable: 'danger',
  unknown: 'idle',
};

/** Ce qu'une création reçoit en entrée : vide, ou pré-rempli par « Superviser ». */
type CreateSeed = { key: number; app: AdoptableApp | null };

export function MonitorsPanel({
  monitors,
  types,
  adoptable,
  canManage,
  retentionDays,
  format,
  record,
}: {
  monitors: MonitorRow[];
  types: TypeOption[];
  adoptable: AdoptableApp[];
  canManage: boolean;
  retentionDays: number;
  /** Locale et fuseau de l'instance, pour les figures. Par props, jamais par
   *  contexte : la frise est rendue sur le serveur avant de l'être ici. */
  format: FormatSettings;
  /** La fiche de la sonde ouverte, rendue au serveur. */
  record: MonitorRecord | null;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState<CreateSeed | null>(null);
  const [deleting, setDeleting] = React.useState<MonitorRow | null>(null);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);
  const drawer = useRecordSelection(
    'monitor',
    monitors.map((monitor) => monitor.id),
  );
  const current = monitors.find((monitor) => monitor.id === drawer.selected) ?? null;
  const [editParam, setEditParam] = useRecordParam('edit');

  async function errorOf(response: Response): Promise<string> {
    const body = (await response.json().catch(() => ({}))) as ApiError;
    return body.error?.message ?? tc('http.failure', { status: response.status });
  }

  async function call(path: string, init: RequestInit, key: string): Promise<boolean> {
    setBusy(key);
    setError(null);
    const response = await fetch(path, init);
    if (!response.ok) {
      setError(await errorOf(response));
      setBusy(null);
      return false;
    }
    setBusy(null);
    router.refresh();
    return true;
  }

  async function toggle(monitor: MonitorRow): Promise<void> {
    const done = await call(
      `/api/monitors/${monitor.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !monitor.enabled }),
      },
      monitor.id,
    );
    if (done) {
      toast({
        title: monitor.enabled
          ? t('toast.paused', { name: monitor.name })
          : t('toast.resumed', { name: monitor.name }),
      });
    }
  }

  async function probeNow(monitor: MonitorRow): Promise<void> {
    const done = await call(`/api/monitors/${monitor.id}/check`, { method: 'POST' }, monitor.id);
    if (done) {
      toast({
        title: t('toast.probed', { name: monitor.name }),
        description: t('toast.probed.detail'),
        tone: 'accent',
      });
    }
  }

  async function remove(monitor: MonitorRow): Promise<void> {
    setBusy(monitor.id);
    setDeleteError(null);
    const response = await fetch(`/api/monitors/${monitor.id}`, { method: 'DELETE' });
    setBusy(null);
    if (!response.ok) {
      setDeleteError(await errorOf(response));
      return;
    }
    setDeleting(null);
    if (drawer.selected === monitor.id) drawer.close();
    toast({ title: t('toast.deleted', { name: monitor.name }) });
    router.refresh();
  }

  const openCreate = (app: AdoptableApp | null) =>
    setCreating((previous) => ({ key: (previous?.key ?? 0) + 1, app }));

  return (
    <>
      <PageHeader
        title={t('page.title')}
        description={t('page.description')}
        actions={
          canManage ? (
            <Button onClick={() => openCreate(null)}>
              <Plus aria-hidden />
              {t('action.declare')}
            </Button>
          ) : undefined
        }
      />

      {error ? <Alert variant="destructive">{error}</Alert> : null}

      {canManage && adoptable.length > 0 ? (
        <section className="card">
          <div className="flex flex-wrap items-center gap-4 px-4 py-3.5">
            <span className="dlg-icon is-accent size-8" aria-hidden>
              <Radar />
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="t-sm font-semibold text-text">
                {t('adopt.count', { count: adoptable.length })}
              </span>
              <span className="t-cap text-text-3">{t('adopt.short')}</span>
            </div>
            <span className="flex flex-wrap gap-2">
              {adoptable.map((app) => (
                <Button
                  key={app.applicationId}
                  size="sm"
                  variant="secondary"
                  onClick={() => openCreate(app)}
                >
                  <Plus aria-hidden />
                  {t('adopt.action', { slug: app.slug })}
                </Button>
              ))}
            </span>
          </div>
        </section>
      ) : null}

      {monitors.length === 0 ? (
        <EmptyState
          icon={Radar}
          title={t('empty.title')}
          hint={canManage ? t('empty.hint.canManage') : t('empty.hint.readOnly')}
          action={
            canManage ? (
              <Button onClick={() => openCreate(null)}>
                <Plus aria-hidden />
                {t('action.declare')}
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {monitors.map((monitor) => (
            <MonitorCard
              key={monitor.id}
              monitor={monitor}
              canManage={canManage}
              format={format}
              busy={busy === monitor.id}
              selected={drawer.selected === monitor.id}
              onOpen={(tab) => drawer.open(monitor.id, tab ? { tab } : undefined)}
              onToggle={() => void toggle(monitor)}
              onProbe={() => void probeNow(monitor)}
              onRemove={() => {
                setDeleteError(null);
                setDeleting(monitor);
              }}
            />
          ))}
          <p className="t-cap text-text-3">{t('retention.note', { count: retentionDays })}</p>
        </div>
      )}

      <MonitorDrawer
        monitor={current}
        record={drawer.loading || record?.key !== current?.id ? null : record}
        editing={editParam === '1'}
        onEdit={(editing) => setEditParam(editing ? '1' : null)}
        onEdited={(name) => {
          setEditParam(null);
          toast({ title: t('toast.updated', { name }), tone: 'ok' });
          router.refresh();
        }}
        onClose={drawer.close}
        onPrevious={drawer.onPrevious}
        onNext={drawer.onNext}
        canManage={canManage}
        busy={current !== null && busy === current.id}
        format={format}
        onToggle={() => (current ? void toggle(current) : undefined)}
        onProbe={() => (current ? void probeNow(current) : undefined)}
      />

      {canManage ? (
        <CreateDrawer
          seed={creating}
          types={types}
          onOpenChange={(open) => (open ? undefined : setCreating(null))}
          onCreated={(name) => {
            setCreating(null);
            toast({ title: t('toast.created', { name }) });
            router.refresh();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => (open ? undefined : setDeleting(null))}
        level="trace"
        icon={<Trash2 />}
        title={deleting ? t('delete.title', { name: deleting.name }) : ''}
        consequences={[t('delete.checks'), t('delete.alerts')]}
        confirmLabel={t('delete.confirm')}
        pending={deleting !== null && busy === deleting.id}
        error={deleteError}
        onConfirm={() => (deleting ? remove(deleting) : undefined)}
      />
    </>
  );
}

/**
 * Le motif d'une suspension, rendu à la lecture.
 *
 * `paused_reason` porte une **clé** quand le balayage l'a écrite, et du texte
 * libre sinon — une ligne d'avant ce changement, ou un motif qu'un humain aura
 * saisi un jour. On traduit ce qu'on reconnaît, on affiche le reste tel quel :
 * c'est ce qui laisse les lignes déjà en base intactes.
 */
function pausedReasonLabel(raw: string, t: Messages): string {
  const pause = parseMonitorPause(raw);
  if (pause.reason === 'orphaned') return t('card.paused.orphaned');
  if (pause.reason === 'unknownType') return t('card.paused.unknownType', { type: pause.type });
  return pause.text;
}

/**
 * Un taux en pourcentage, sans le décompte : celui-ci est dans l'infobulle.
 * `Intl` place le signe selon la langue — « 98,84 % » en français, « 98.84% »
 * en anglais — et 100 s'écrit sans décimale.
 */
function percentOf(ratio: number | null, format: FormatSettings): string {
  if (ratio === null) return '—';
  return formatNumber(ratio, format, {
    style: 'percent',
    minimumFractionDigits: ratio === 1 ? 0 : 1,
    maximumFractionDigits: 2,
  });
}

function MonitorCard({
  monitor,
  canManage,
  format,
  busy,
  selected,
  onOpen,
  onToggle,
  onProbe,
  onRemove,
}: {
  monitor: MonitorRow;
  canManage: boolean;
  format: FormatSettings;
  busy: boolean;
  selected: boolean;
  /** Ouvre la fiche, sur un onglet précis si on le donne. */
  onOpen: (tab?: string) => void;
  onToggle: () => void;
  onProbe: () => void;
  onRemove: () => void;
}) {
  const t = useT(messages);
  // `formatSince` appartient à l'écran des applications et parle son
  // vocabulaire : on lui passe son `t`, sinon il retombe sur le français.
  const tSince = useT(servers);
  const language = useLanguage();

  // Un échec en cours mais pas encore confirmé : l'écran le dit franchement
  // plutôt que d'afficher « sain » ou « en panne », qui seraient tous deux faux.
  const pending =
    monitor.consecutiveFailures > 0 && monitor.consecutiveFailures < monitor.failureThreshold;
  const failing = monitor.status === 'unreachable' || monitor.status === 'unhealthy';

  return (
    <section
      className={
        selected ? 'card overflow-hidden border-accent shadow-focus' : 'card overflow-hidden'
      }
      aria-label={monitor.name}
    >
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-3 px-4 py-3.5">
        <div className="flex w-[260px] max-w-full min-w-0 flex-col gap-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <button
              type="button"
              className="truncate text-left text-[14px] font-semibold text-text hover:underline"
              aria-label={t('card.open', { name: monitor.name })}
              onClick={() => onOpen()}
            >
              {monitor.name}
            </button>
            <Badge variant="outline">{monitor.typeLabel}</Badge>
            {!monitor.enabled && !monitor.pausedReason ? (
              <Badge>{t('card.badge.paused')}</Badge>
            ) : null}
          </span>
          <span className="mono truncate text-[11.5px] text-text-3">{monitor.target}</span>
        </div>

        <div className="flex w-[170px] flex-col gap-1">
          <State tone={STATUS_TONE[monitor.status]} pulse={monitor.openIncidentSince !== null}>
            {t(`outcome.${monitor.status}`)}
          </State>
          <span className="t-cap text-text-3">
            {monitor.neverRan
              ? t('card.neverRan')
              : t('card.measured', {
                  since: formatSince(monitor.lastCheckedAt, tSince),
                  cadence: formatCadence(monitor.intervalSeconds, language),
                })}
          </span>
          {pending ? (
            <Badge variant="warn" className="self-start">
              {t('card.pending', {
                count: monitor.consecutiveFailures,
                threshold: monitor.failureThreshold,
              })}
            </Badge>
          ) : null}
        </div>

        <div className="flex min-w-[160px] flex-1 flex-col gap-1.5">
          <OutcomeStrip points={monitor.recent} format={format} height={18} />
          <StripAxis points={monitor.recent} format={format} />
        </div>

        <div className="w-[150px] max-xl:hidden">
          <LatencySparkline
            points={monitor.recent}
            tone={failing ? 'var(--danger)' : 'var(--accent)'}
          />
        </div>

        <div className="flex w-[84px] flex-col text-right" title={monitor.uptime24h.label}>
          <span className="t-cap text-text-3">{t('card.window.day')}</span>
          <span className="t-sm num font-semibold text-text">
            {percentOf(monitor.uptime24h.ratio, format)}
          </span>
        </div>
        <div className="flex w-[72px] flex-col text-right" title={monitor.uptime7d.label}>
          <span className="t-cap text-text-3">{t('card.window.week')}</span>
          <span className="t-sm num font-semibold text-text">
            {percentOf(monitor.uptime7d.ratio, format)}
          </span>
        </div>

        {canManage ? (
          <span className="flex items-center gap-0.5">
            <IconButton
              label={t('card.action.probe')}
              size="icon-sm"
              disabled={busy}
              onClick={onProbe}
            >
              <Play />
            </IconButton>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label={t('card.more')} size="icon-sm">
                  <Ellipsis />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={onToggle}>
                  {monitor.enabled ? <Pause aria-hidden /> : <Play aria-hidden />}
                  {monitor.enabled ? t('card.action.pause') : t('card.action.resume')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onOpen('measures')}>
                  {t('card.action.detail')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={onRemove}>
                  <Trash2 aria-hidden />
                  {t('delete.confirm')}…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        ) : null}
      </div>

      {monitor.openIncidentSince ? (
        <div className="flex flex-wrap items-center gap-2.5 border-t border-danger-line bg-danger-soft px-4 py-2.5">
          <CircleAlert aria-hidden className="text-danger" />
          <span className="t-sm">
            <strong>
              {t('card.incidentOpen', { since: formatSince(monitor.openIncidentSince, tSince) })}
            </strong>
          </span>
          <button type="button" className="link t-cap ml-auto" onClick={() => onOpen('measures')}>
            {t('card.incidentTimeline')}
          </button>
        </div>
      ) : null}

      {monitor.pausedReason ? (
        <div className="flex items-center gap-2.5 border-t border-warn-line bg-warn-soft px-4 py-2.5">
          <TriangleAlert aria-hidden className="text-warn" />
          <span className="t-sm">
            {t('card.paused', { reason: pausedReasonLabel(monitor.pausedReason, t) })}
          </span>
        </div>
      ) : null}
    </section>
  );
}

/**
 * La fiche d'une sonde, dans un tiroir. L'aperçu se lit sur la carte — sa
 * cible et sa règle, ses derniers passages, son dernier relevé ; la courbe,
 * les incidents et la capture de référence arrivent du serveur. « Modifier »
 * remplace la fiche par le formulaire, dans le même tiroir.
 */
function MonitorDrawer({
  monitor,
  record,
  editing,
  onEdit,
  onEdited,
  onClose,
  onPrevious,
  onNext,
  canManage,
  busy,
  format,
  onToggle,
  onProbe,
}: {
  monitor: MonitorRow | null;
  /** La fiche rendue au serveur, si c'est bien celle de `monitor`. */
  record: MonitorRecord | null;
  editing: boolean;
  onEdit: (editing: boolean) => void;
  onEdited: (name: string) => void;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  canManage: boolean;
  busy: boolean;
  format: FormatSettings;
  onToggle: () => void;
  onProbe: () => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const tSince = useT(servers);
  const language = useLanguage();

  const overview = monitor ? (
    <>
      {record?.alerts}
      <DrawerSection title={t('drawer.target')}>
        {monitor.targetLink ? (
          <a
            href={monitor.targetLink}
            target="_blank"
            rel="noreferrer"
            className="link mono t-sm break-all"
          >
            {monitor.target}
          </a>
        ) : (
          <span className="mono t-sm break-all">{monitor.target}</span>
        )}
        <span className="t-cap text-text-3">
          {t('drawer.summary', {
            typeLabel: monitor.typeLabel,
            cadence: formatCadence(monitor.intervalSeconds, language),
            failures: t('detail.failures', { count: monitor.failureThreshold }),
            recovery: monitor.recoveryThreshold,
          })}
        </span>
      </DrawerSection>

      {monitor.openIncidentSince ? (
        <Alert variant="destructive">
          {t('card.incidentOpen', { since: formatSince(monitor.openIncidentSince, tSince) })}
        </Alert>
      ) : null}

      <DrawerSection title={t('drawer.recent')}>
        {monitor.recent.length === 0 ? (
          <p className="t-sm text-text-3">{t('card.neverRan')}</p>
        ) : (
          <>
            <OutcomeStrip points={monitor.recent} format={format} height={22} />
            <StripAxis points={monitor.recent} format={format} ticks={3} />
          </>
        )}
      </DrawerSection>

      <DrawerSection title={t('drawer.last')}>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4">
          <FieldValue label={t('drawer.latency')}>
            <span className="num">
              {monitor.lastLatencyMs === null ? tc('none') : `${monitor.lastLatencyMs} ms`}
            </span>
          </FieldValue>
          <FieldValue label={t('drawer.detail')}>
            <span className="mono break-all">{monitor.lastDetail ?? tc('none')}</span>
          </FieldValue>
        </div>
      </DrawerSection>
    </>
  ) : null;

  return (
    <RecordDrawer
      open={monitor !== null}
      recordKey={monitor?.id ?? null}
      onClose={onClose}
      onPrevious={onPrevious}
      onNext={onNext}
      label={monitor?.name}
      tabsLabel={t('record.tabs')}
      tabs={[
        { key: 'overview', label: t('record.tab.overview'), content: overview },
        {
          key: 'measures',
          label: t('record.tab.measures'),
          content: record ? (record.tabs.measures ?? null) : undefined,
        },
        {
          key: 'reference',
          label: t('record.tab.reference'),
          content: record ? (record.tabs.reference ?? null) : undefined,
        },
      ]}
      header={
        monitor ? (
          <DrawerHeader
            icon={<Radar />}
            kind={t('drawer.kind')}
            route={monitor.typeLabel}
            title={monitor.name}
            state={
              <>
                <State
                  tone={STATUS_TONE[monitor.status]}
                  meta={
                    monitor.neverRan
                      ? t('card.neverRan')
                      : formatSince(monitor.lastCheckedAt, tSince)
                  }
                >
                  {t(`outcome.${monitor.status}`)}
                </State>
                {!monitor.enabled ? <Badge>{t('card.badge.paused')}</Badge> : null}
                <span className="ml-auto flex gap-1.5">
                  <Badge title={monitor.uptime24h.label}>
                    {t('card.window.day')} {percentOf(monitor.uptime24h.ratio, format)}
                  </Badge>
                  <Badge title={monitor.uptime7d.label}>
                    {t('card.window.week')} {percentOf(monitor.uptime7d.ratio, format)}
                  </Badge>
                </span>
              </>
            }
          />
        ) : null
      }
      footer={() =>
        monitor ? (
          <DrawerFooter
            end={
              canManage ? (
                <Button variant="ghost" disabled={busy} onClick={onToggle}>
                  {monitor.enabled ? t('card.action.pause') : t('card.action.resume')}
                </Button>
              ) : null
            }
          >
            {canManage ? (
              <Button loading={busy} onClick={onProbe}>
                {busy ? null : <Play aria-hidden />}
                {t('card.action.probe')}
              </Button>
            ) : null}
            {record?.edit ? (
              <Button variant="secondary" onClick={() => onEdit(true)}>
                <Pencil aria-hidden />
                {t('edit.action')}
              </Button>
            ) : null}
          </DrawerFooter>
        ) : null
      }
      override={
        editing && record?.edit ? (
          <MonitorForm
            mode="edit"
            monitor={record.edit.monitor}
            types={record.edit.types}
            onDone={onEdited}
            onCancel={() => onEdit(false)}
          />
        ) : undefined
      }
    />
  );
}

// ─── création ─────────────────────────────────────────────────────────────────

function CreateDrawer({
  seed,
  types,
  onOpenChange,
  onCreated,
}: {
  seed: CreateSeed | null;
  types: TypeOption[];
  onOpenChange: (open: boolean) => void;
  onCreated: (name: string) => void;
}) {
  const t = useT(messages);
  return (
    <Drawer open={seed !== null} onOpenChange={onOpenChange} wide label={t('create.title')}>
      {seed ? (
        // Une clé par ouverture : « Superviser » repart d'un formulaire pré-rempli.
        <MonitorForm key={seed.key} mode="create" app={seed.app} types={types} onDone={onCreated} />
      ) : null}
    </Drawer>
  );
}
