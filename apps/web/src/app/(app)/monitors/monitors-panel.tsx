'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { formatCadence, parseMonitorPause, type MonitorType, type Translate } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { EmptyState } from '@/components/empty-state';
import { useLanguage, useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { monitors as messages } from '@/i18n/messages/monitors';
import { servers } from '@/i18n/messages/servers';
import { HealthDot, formatSince } from '@/app/(app)/apps/apps-table';
import type { FormatSettings } from '@/lib/format';
import { cleanConfig, ConfigFields, defaultsOf, type ConfigValues } from './config-fields';
import { LatencySparkline, OutcomeLegend, OutcomeStrip } from './monitor-charts';

/**
 * L'écran des sondes.
 *
 * Trois principes de lecture, tous demandés par le brief et tenus ici :
 *
 *   — l'état se lit **à la forme autant qu'à la couleur** : `HealthDot`, le même
 *     voyant que l'écran de supervision des applications, donc la même
 *     convention à apprendre une seule fois ;
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

export type TypeOption = {
  type: MonitorType;
  label: string;
  description: string;
  neverDoes: string;
  fields: Parameters<typeof ConfigFields>[0]['fields'];
  minIntervalSeconds: number;
  defaultIntervalSeconds: number;
  defaults: unknown;
  uptimeMeans: string;
};

export type AdoptableApp = {
  applicationId: string;
  slug: string;
  name: string;
  url: string;
};

type ApiError = { error?: { message?: string } };

/** Les cadences proposées. Filtrées par le minimum que le type déclare. */
const INTERVAL_CHOICES = [30, 60, 300, 900, 3_600, 6 * 3_600, 12 * 3_600, 86_400];

export function MonitorsPanel({
  monitors,
  types,
  adoptable,
  canManage,
  retentionDays,
  format,
}: {
  monitors: MonitorRow[];
  types: TypeOption[];
  adoptable: AdoptableApp[];
  canManage: boolean;
  retentionDays: number;
  /** Locale et fuseau de l'instance, pour les figures. Par props, jamais par
   *  contexte : la frise est rendue sur le serveur avant de l'être ici. */
  format: FormatSettings;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);

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
    await call(
      `/api/monitors/${monitor.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !monitor.enabled }),
      },
      monitor.id,
    );
  }

  async function probeNow(monitor: MonitorRow): Promise<void> {
    await call(`/api/monitors/${monitor.id}/check`, { method: 'POST' }, monitor.id);
  }

  async function remove(monitor: MonitorRow): Promise<void> {
    if (!window.confirm(t('confirm.delete', { name: monitor.name }))) {
      return;
    }
    await call(`/api/monitors/${monitor.id}`, { method: 'DELETE' }, monitor.id);
  }

  return (
    <div className="flex flex-col gap-5">
      {error ? <Alert variant="destructive">{error}</Alert> : null}

      {canManage ? (
        <CreateMonitor
          types={types}
          adoptable={adoptable}
          open={creating}
          onOpenChange={setCreating}
          onCreated={() => {
            setCreating(false);
            router.refresh();
          }}
          onError={setError}
        />
      ) : null}

      {monitors.length === 0 ? (
        <EmptyState
          title={t('empty.title')}
          hint={canManage ? t('empty.hint.canManage') : t('empty.hint.readOnly')}
          action={
            canManage ? (
              <Button onClick={() => setCreating(true)}>{t('action.declare')}</Button>
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
              onToggle={() => void toggle(monitor)}
              onProbe={() => void probeNow(monitor)}
              onRemove={() => void remove(monitor)}
            />
          ))}
          <p className="text-[0.6875rem] text-text-3">
            {t('retention.note', { count: retentionDays })}
          </p>
        </div>
      )}
    </div>
  );
}

type Messages = Translate<(typeof messages)['fr']>;

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

function MonitorCard({
  monitor,
  canManage,
  format,
  busy,
  onToggle,
  onProbe,
  onRemove,
}: {
  monitor: MonitorRow;
  canManage: boolean;
  format: FormatSettings;
  busy: boolean;
  onToggle: () => void;
  onProbe: () => void;
  onRemove: () => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  // `formatSince` appartient à l'écran des applications et parle son
  // vocabulaire : on lui passe son `t`, sinon il retombe sur le français.
  const tSince = useT(servers);
  const language = useLanguage();

  // Un échec en cours mais pas encore confirmé : l'écran le dit franchement
  // plutôt que d'afficher « sain » ou « en panne », qui seraient tous deux faux.
  const pending =
    monitor.consecutiveFailures > 0 && monitor.consecutiveFailures < monitor.failureThreshold;

  return (
    <Card className="gap-4">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 space-y-1">
          <CardTitle className="flex flex-wrap items-center gap-2">
            <Link href={`/monitors/${monitor.id}`} className="underline-offset-4 hover:underline">
              {monitor.name}
            </Link>
            <Badge variant="secondary">{monitor.typeLabel}</Badge>
            {monitor.hasWebhook ? <Badge variant="outline">{t('card.badge.alert')}</Badge> : null}
            {monitor.applicationId ? (
              <Badge variant="outline">{t('card.badge.application')}</Badge>
            ) : null}
          </CardTitle>
          <CardDescription className="font-mono text-xs break-all">
            {monitor.targetLink ? (
              <a
                href={monitor.targetLink}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-4"
              >
                {monitor.target}
              </a>
            ) : (
              monitor.target
            )}
          </CardDescription>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canManage ? (
            <>
              <Button size="sm" variant="outline" disabled={busy} onClick={onProbe}>
                {busy ? t('card.action.probing') : t('card.action.probe')}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={onToggle}>
                {monitor.enabled ? t('card.action.pause') : t('card.action.resume')}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={onRemove}>
                {tc('delete')}
              </Button>
            </>
          ) : null}
          <Button asChild size="sm" variant="outline">
            <Link href={`/monitors/${monitor.id}`}>{t('card.action.detail')}</Link>
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {monitor.pausedReason ? (
          <Alert variant="warn">
            {t('card.paused', { reason: pausedReasonLabel(monitor.pausedReason, t) })}
          </Alert>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_auto]">
          <div className="space-y-1">
            <HealthDot health={monitor.status} label={t(`health.${monitor.status}`)} />
            {monitor.neverRan ? (
              <p className="text-[0.6875rem] text-text-3">{t('card.neverRan')}</p>
            ) : (
              <p className="text-[0.6875rem] text-text-3">
                {t('card.measured', {
                  since: formatSince(monitor.lastCheckedAt, tSince),
                  cadence: formatCadence(monitor.intervalSeconds, language),
                })}
              </p>
            )}
            {pending ? (
              <Badge variant="warn" className="mt-1">
                {t('card.pending', {
                  count: monitor.consecutiveFailures,
                  threshold: monitor.failureThreshold,
                })}
              </Badge>
            ) : null}
            {!monitor.enabled && !monitor.pausedReason ? (
              <Badge variant="secondary" className="mt-1">
                {t('card.badge.paused')}
              </Badge>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
              <span className="text-text">
                <span className="eyebrow text-text-3">{t('card.window.day')} </span>
                {monitor.uptime24h.label}
              </span>
              <span className="text-text-2">
                <span className="eyebrow text-text-3">{t('card.window.week')} </span>
                {monitor.uptime7d.label}
              </span>
            </div>
            <OutcomeStrip points={monitor.recent} format={format} height={18} />
            {monitor.recent.length > 0 ? <OutcomeLegend /> : null}
          </div>

          <div className="flex flex-col items-end justify-center gap-1">
            <LatencySparkline points={monitor.recent} />
            <span className="font-mono text-[0.6875rem] text-text-2">
              {monitor.lastLatencyMs === null ? tc('none') : `${monitor.lastLatencyMs} ms`}
            </span>
          </div>
        </div>

        {monitor.lastDetail ? (
          <p className="font-mono text-[0.6875rem] break-all text-text-2">
            {monitor.lastDetail}
          </p>
        ) : null}

        {monitor.openIncidentSince ? (
          <Alert variant="destructive">
            {t('card.incidentOpen', { since: formatSince(monitor.openIncidentSince, tSince) })}{' '}
            <Link href={`/monitors/${monitor.id}`} className="underline underline-offset-4">
              {t('card.incidentTimeline')}
            </Link>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ─── création ─────────────────────────────────────────────────────────────────

function CreateMonitor({
  types,
  adoptable,
  open,
  onOpenChange,
  onCreated,
  onError,
}: {
  types: TypeOption[];
  adoptable: AdoptableApp[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  onError: (message: string | null) => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const language = useLanguage();
  const first = types[0];
  const [type, setType] = React.useState<MonitorType>(first?.type ?? 'http');
  const [name, setName] = React.useState('');
  const [config, setConfig] = React.useState<ConfigValues>(defaultsOf(first?.defaults));
  const [intervalSeconds, setIntervalSeconds] = React.useState(
    first?.defaultIntervalSeconds ?? 60,
  );
  const [failureThreshold, setFailureThreshold] = React.useState(3);
  const [recoveryThreshold, setRecoveryThreshold] = React.useState(2);
  const [webhookUrl, setWebhookUrl] = React.useState('');
  const [applicationId, setApplicationId] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const definition = types.find((option) => option.type === type) ?? first;

  function pickType(next: MonitorType): void {
    const option = types.find((entry) => entry.type === next);
    setType(next);
    setConfig(defaultsOf(option?.defaults));
    setIntervalSeconds(option?.defaultIntervalSeconds ?? 60);
    setApplicationId(null);
  }

  /** Le bouton « Superviser » d'une application : la sonde est pré-remplie. */
  function adopt(app: AdoptableApp): void {
    const httpOption = types.find((entry) => entry.type === 'http');
    setType('http');
    setConfig({ ...defaultsOf(httpOption?.defaults), url: app.url });
    setIntervalSeconds(httpOption?.defaultIntervalSeconds ?? 60);
    setName(app.name);
    setApplicationId(app.applicationId);
    onOpenChange(true);
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    onError(null);

    const response = await fetch('/api/monitors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        type,
        config: cleanConfig(config),
        intervalSeconds,
        failureThreshold,
        recoveryThreshold,
        applicationId,
        webhookUrl: webhookUrl.trim() === '' ? null : webhookUrl.trim(),
      }),
    });

    setSubmitting(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      onError(body.error?.message ?? tc('http.failure', { status: response.status }));
      return;
    }

    setName('');
    setWebhookUrl('');
    setApplicationId(null);
    setConfig(defaultsOf(definition?.defaults));
    onCreated();
  }

  const intervals = INTERVAL_CHOICES.filter(
    (seconds) => seconds >= (definition?.minIntervalSeconds ?? 30),
  );

  return (
    <div className="space-y-3">
      {adoptable.length > 0 ? (
        <Card className="gap-3">
          <CardHeader>
            <CardTitle>{t('adopt.title')}</CardTitle>
            <CardDescription>{t('adopt.description')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {adoptable.map((app) => (
              <Button
                key={app.applicationId}
                size="sm"
                variant="outline"
                onClick={() => adopt(app)}
              >
                {t('adopt.action', { slug: app.slug })}
              </Button>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {!open ? (
        <Button onClick={() => onOpenChange(true)}>{t('action.declare')}</Button>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{t('create.title')}</CardTitle>
            {definition ? (
              <CardDescription>
                {definition.description} {definition.neverDoes}
              </CardDescription>
            ) : null}
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={(event) => void submit(event)}>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="monitor-name">{t('create.name.label')}</Label>
                  <Input
                    id="monitor-name"
                    value={name}
                    required
                    maxLength={120}
                    placeholder={t('create.name.placeholder')}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="monitor-type">{t('create.type.label')}</Label>
                  <Select
                    id="monitor-type"
                    value={type}
                    onChange={(event) => pickType(event.target.value as MonitorType)}
                  >
                    {types.map((option) => (
                      <option key={option.type} value={option.type}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>

              {definition ? (
                <ConfigFields
                  fields={definition.fields}
                  values={config}
                  idPrefix="monitor-config"
                  onChange={(key, value) =>
                    setConfig((previous) => ({ ...previous, [key]: value }))
                  }
                />
              ) : null}

              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="monitor-interval">{t('create.interval.label')}</Label>
                  <Select
                    id="monitor-interval"
                    value={String(intervalSeconds)}
                    onChange={(event) => setIntervalSeconds(Number(event.target.value))}
                  >
                    {intervals.map((seconds) => (
                      <option key={seconds} value={seconds}>
                        {formatCadence(seconds, language)}
                      </option>
                    ))}
                  </Select>
                  {definition ? (
                    <p className="text-[0.6875rem] text-text-3">
                      {t('create.interval.floor', {
                        cadence: formatCadence(definition.minIntervalSeconds, language),
                      })}
                    </p>
                  ) : null}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="monitor-failure">{t('create.failure.label')}</Label>
                  <Input
                    id="monitor-failure"
                    type="number"
                    min={1}
                    max={10}
                    value={failureThreshold}
                    onChange={(event) => setFailureThreshold(Number(event.target.value))}
                  />
                  <p className="text-[0.6875rem] text-text-3">{t('create.failure.hint')}</p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="monitor-recovery">{t('create.recovery.label')}</Label>
                  <Input
                    id="monitor-recovery"
                    type="number"
                    min={1}
                    max={10}
                    value={recoveryThreshold}
                    onChange={(event) => setRecoveryThreshold(Number(event.target.value))}
                  />
                  <p className="text-[0.6875rem] text-text-3">{t('create.recovery.hint')}</p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="monitor-webhook">{t('create.webhook.label')}</Label>
                <Input
                  id="monitor-webhook"
                  type="url"
                  value={webhookUrl}
                  placeholder={t('create.webhook.placeholder')}
                  onChange={(event) => setWebhookUrl(event.target.value)}
                />
                <p className="text-[0.6875rem] text-text-3">
                  {t('create.webhook.payload.a')}
                  <strong>{t('create.webhook.payload.and')}</strong>
                  {t('create.webhook.payload.b')}
                  <code className="font-mono">text</code>
                  {t('create.webhook.payload.c')}{' '}
                  <code className="font-mono">content</code>
                  {t('create.webhook.payload.d')}
                </p>
                {/*
                  Deux sorties existent désormais pour la même panne. Le dire ici,
                  au moment de saisir l'URL, est le seul endroit où l'information
                  arrive à temps : sinon l'opérateur découvre le doublon en le
                  recevant, et conclut à un bug.
                */}
                <p className="text-[0.6875rem] text-text-3">
                  {t('create.webhook.scope.a')}
                  <strong>{t('create.webhook.scope.only')}</strong>
                  {t('create.webhook.scope.b')}
                  <strong>{t('create.webhook.scope.all')}</strong>
                  {t('create.webhook.scope.c')}
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={submitting}>
                  {submitting ? tc('creating') : t('create.submit')}
                </Button>
                <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                  {tc('cancel')}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
