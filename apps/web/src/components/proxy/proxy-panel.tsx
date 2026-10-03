'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  CircleCheck,
  CircleX,
  Link2,
  LoaderCircle,
  Network,
  Pencil,
  PlugZap,
  ScanSearch,
  Trash2,
  Unlink,
} from 'lucide-react';
import type { ProxyDetection, ProxyInstallOption } from '@pupitre/core/proxy';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckboxField } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented';
import { Select } from '@/components/ui/select';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { proxy as messages } from '@/i18n/messages/proxy';
import type {
  LinkViewForUi,
  ProxyViewForUi,
  RemoteProxyViewForUi,
  RouteViewForUi,
} from '@/lib/proxy';
import { formatDateTime, type FormatSettings } from '@/lib/format';
import { toast } from '@/lib/toast';
import { NpmConnectionDrawer } from './npm-connection-drawer';

/**
 * Le reverse proxy d'une machine : le trouver, l'installer, le tester, le
 * retirer, et voir les domaines qui passent par lui. Ou bien relier la machine
 * au proxy d'une autre — le proxy central. Sur la page de la cible et dans
 * l'assistant de démarrage — le même composant aux deux endroits.
 *
 * La carte se lit elle-même et se relit tant qu'une installation ou un test
 * est en cours : ils prennent de quelques secondes à deux minutes.
 */

type Data = {
  proxy: ProxyViewForUi | null;
  link: LinkViewForUi | null;
  /** Les machines que le proxy de celle-ci sert par liaison. */
  served: Array<{
    targetId: string;
    targetName: string;
    address: string;
    status: LinkViewForUi['status'];
  }>;
  /**
   * Les proxies auxquels on peut relier celle-ci : ceux des autres machines,
   * puis les proxies distants (`targetId` nul) — Nginx Proxy Manager.
   */
  candidates: Array<{
    proxyId: string;
    targetId: string | null;
    targetName: string;
    description: string;
  }>;
  /** L'adresse proposée pour la liaison : celle par laquelle Pupitre la joint. */
  suggestedAddress: string;
  routes: RouteViewForUi[];
};
type Detected = { detections: ProxyDetection[]; installOptions: ProxyInstallOption[] };
type ApiError = { error?: { message?: string } };
type AcmeServer = ProxyInstallOption['acmeServers'][number];

/** Une option d'installation, nommée avec son genre : deux proxies peuvent avoir la même clé. */
const optionId = (candidate: Pick<ProxyInstallOption, 'kind' | 'key'>) =>
  `${candidate.kind}:${candidate.key}`;

const STATUS_VARIANT = {
  unknown: 'idle',
  installing: 'accent',
  ok: 'ok',
  failed: 'danger',
} as const;
const ROUTE_VARIANT = { pending: 'idle', active: 'ok', failed: 'danger' } as const;

export function ProxyPanel({
  targetId,
  targetName,
  canManage,
  format,
  defaultEmail,
  onProxyChange,
}: {
  targetId: string;
  targetName: string;
  canManage: boolean;
  format: FormatSettings;
  /** L'e-mail proposé pour Let's Encrypt : celui de la personne connectée. */
  defaultEmail?: string;
  /** Prévenu à chaque relecture : l'assistant sait ainsi quand l'étape est faite. */
  onProxyChange?: (proxy: ProxyViewForUi | null) => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const [data, setData] = useState<Data | null>(null);
  const [detected, setDetected] = useState<Detected | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [option, setOption] = useState<string | null>(null);
  const [email, setEmail] = useState(defaultEmail ?? '');
  const [server, setServer] = useState<AcmeServer>('production');
  const [customUrl, setCustomUrl] = useState('');
  const [caCertificate, setCaCertificate] = useState('');
  const [removing, setRemoving] = useState(false);
  const [uninstall, setUninstall] = useState(true);
  // Un geste en cours : on relit jusqu'à ce que son test soit passé, c'est-à-dire
  // jusqu'à ce que la date du dernier test change. `since` : celle d'avant ;
  // `of` : le test d'un proxy distant, ou celui de la machine et de sa liaison.
  const [watching, setWatching] = useState<{ since: string | null; of: CheckOf } | null>(null);
  const [npmDrawer, setNpmDrawer] = useState<{
    connection: RemoteProxyViewForUi | null;
  } | null>(null);
  const [linkProxyId, setLinkProxyId] = useState('');
  const [linkAddress, setLinkAddress] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch(`/api/targets/${targetId}/proxy`, { cache: 'no-store' }).catch(
      () => null,
    );
    if (!response?.ok) return null;
    return (await response.json()) as Data;
  }, [targetId]);

  const refresh = useCallback(async () => {
    const next = await load();
    if (next) setData(next);
    return next;
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    void load().then((next) => {
      if (!cancelled && next) setData(next);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  // Pour l'assistant : le proxy qui sert la machine, le sien ou celui d'une
  // autre — une liaison en échec ne compte pas comme faite.
  useEffect(() => {
    if (!data) return;
    onProxyChange?.(
      data.proxy ?? (data.link ? { ...data.link.proxy, status: data.link.status } : null),
    );
  }, [data, onProxyChange]);

  // Une installation ou un test en cours : on relit jusqu'à leur issue.
  const pending = data?.proxy?.status === 'installing' || watching !== null;
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => {
      void refresh().then((next) => {
        if (!next) return;
        const checkedAt = lastCheckedAt(next, watching?.of);
        const tested =
          next.proxy?.status !== 'installing' &&
          checkedAt !== null &&
          checkedAt !== watching?.since;
        if (tested || (!next.proxy && !next.link)) setWatching(null);
      });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [pending, refresh, watching]);

  function watch(of: CheckOf = 'machine') {
    setWatching({ since: data ? lastCheckedAt(data, of) : null, of });
  }

  async function call(url: string, init: RequestInit): Promise<Response | null> {
    setError(null);
    const response = await fetch(url, {
      headers: { 'content-type': 'application/json' },
      ...init,
    }).catch(() => null);
    if (!response?.ok) {
      const body = response ? ((await response.json().catch(() => ({}))) as ApiError) : {};
      setError(body.error?.message ?? tc('http.failure', { status: response?.status ?? 0 }));
      return null;
    }
    return response;
  }

  async function detect() {
    setBusy('detect');
    const response = await call(`/api/targets/${targetId}/proxy/detect`, { method: 'POST' });
    setBusy(null);
    if (!response) return;
    const body = (await response.json()) as Detected;
    setDetected(body);
    const first = body.installOptions.find((candidate) => candidate.available);
    choose(first ?? null);
  }

  /** Choisir une option, et une autorité qu'elle sait interroger. */
  function choose(candidate: ProxyInstallOption | null) {
    setOption(candidate ? optionId(candidate) : null);
    if (candidate && !candidate.acmeServers.includes(server)) {
      setServer(candidate.acmeServers[0] ?? 'production');
    }
  }

  async function use(detection: ProxyDetection) {
    setBusy('use');
    const response = await call(`/api/targets/${targetId}/proxy`, {
      method: 'PUT',
      body: JSON.stringify({ kind: detection.kind, config: detection.config }),
    });
    setBusy(null);
    if (!response) return;
    toast({ title: t('connect.done'), tone: 'ok' });
    setDetected(null);
    watch();
    await refresh();
  }

  async function install() {
    const chosen = detected?.installOptions.find((candidate) => optionId(candidate) === option);
    if (!chosen) return;
    setBusy('install');
    const response = await call(`/api/targets/${targetId}/proxy/install`, {
      method: 'POST',
      body: JSON.stringify({
        kind: chosen.kind,
        option: chosen.key,
        acme: {
          email,
          server,
          customUrl: server === 'custom' ? customUrl : null,
          caCertificate: server === 'custom' && caCertificate.trim() ? caCertificate : null,
        },
      }),
    });
    setBusy(null);
    if (!response) return;
    toast({ title: t('install.queued'), description: t('install.running'), tone: 'accent' });
    setDetected(null);
    watch();
    await refresh();
  }

  async function check() {
    setBusy('check');
    const response = await call(`/api/targets/${targetId}/proxy/check`, { method: 'POST' });
    setBusy(null);
    if (!response) return;
    toast({ title: t('checks.queued'), tone: 'accent' });
    watch();
  }

  async function link(proxyId: string, address: string) {
    setBusy('link');
    const response = await call(`/api/targets/${targetId}/proxy/link`, {
      method: 'PUT',
      body: JSON.stringify({ proxyId, address }),
    });
    setBusy(null);
    if (!response) return;
    toast({ title: t('link.linked'), tone: 'ok' });
    setDetected(null);
    watch();
    await refresh();
  }

  async function checkRemote(proxyId: string) {
    setBusy('remoteCheck');
    const response = await call(`/api/proxies/${proxyId}/check`, { method: 'POST' });
    setBusy(null);
    if (!response) return;
    toast({ title: t('remote.checked'), tone: 'accent' });
    watch('remote');
  }

  async function checkLink() {
    setBusy('linkCheck');
    const response = await call(`/api/targets/${targetId}/proxy/link/check`, { method: 'POST' });
    setBusy(null);
    if (!response) return;
    toast({ title: t('link.checked'), tone: 'accent' });
    watch();
  }

  if (!data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('card.title')}</CardTitle>
          <CardDescription>
            <LoaderCircle aria-hidden className="inline size-3.5 animate-spin" />
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const proxy = data.proxy;
  const linked = data.link;
  const chosenProxyId = linkProxyId || data.candidates[0]?.proxyId || '';
  const machines = data.candidates.filter((candidate) => candidate.targetId !== null);
  const remotes = data.candidates.filter((candidate) => candidate.targetId === null);
  const address = linkAddress ?? data.suggestedAddress;
  const serverLabel = (value: string) =>
    value === 'production' || value === 'staging' || value === 'zerossl' || value === 'custom'
      ? t(`install.server.${value}`)
      : value;

  return (
    <Card>
      <CardHeader
        actions={
          canManage ? (
            linked ? (
              <span className="flex gap-2">
                {linked.remote ? (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={busy === 'remoteCheck'}
                      onClick={() => void checkRemote(linked.remote!.id)}
                    >
                      {busy === 'remoteCheck' ? null : <PlugZap aria-hidden />}
                      {t('action.checkRemote')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setNpmDrawer({ connection: linked.remote })}
                    >
                      <Pencil aria-hidden />
                      {t('action.editRemote')}
                    </Button>
                  </>
                ) : null}
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy === 'linkCheck'}
                  onClick={() => void checkLink()}
                >
                  {busy === 'linkCheck' ? null : <PlugZap aria-hidden />}
                  {t('action.linkCheck')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setUnlinking(true)}>
                  <Unlink aria-hidden />
                  {t('action.unlink')}
                </Button>
              </span>
            ) : proxy ? (
              <span className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy === 'check'}
                  disabled={proxy.status === 'installing'}
                  onClick={() => void check()}
                >
                  {busy === 'check' ? null : <PlugZap aria-hidden />}
                  {t('action.check')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={proxy.status === 'installing'}
                  onClick={() => {
                    setUninstall(proxy.managed);
                    setRemoving(true);
                  }}
                >
                  <Trash2 aria-hidden />
                  {t('action.remove')}
                </Button>
              </span>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                loading={busy === 'detect'}
                onClick={() => void detect()}
              >
                {busy === 'detect' ? null : <ScanSearch aria-hidden />}
                {busy === 'detect' ? t('action.detecting') : t('action.detect')}
              </Button>
            )
          ) : null
        }
      >
        <CardTitle>{t('card.title')}</CardTitle>
        <CardDescription>{t('card.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error ? <Alert variant="destructive">{error}</Alert> : null}

        {linked ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="t-sm font-medium">
                {t(linked.remote ? 'link.viaRemote' : 'link.via', {
                  target: linked.hostTargetName,
                })}
              </span>
              <Badge variant={STATUS_VARIANT[linked.status]} dot>
                {pending ? <LoaderCircle aria-hidden className="size-3 animate-spin" /> : null}
                {t(`link.status.${linked.status}`)}
              </Badge>
            </div>
            <p className="t-sm mono text-text-2">{linked.proxy.description}</p>
            <p className="t-cap text-text-3">
              {t('link.addresses', { address: linked.address })}
              {linked.sourceAddress ? t('link.source', { source: linked.sourceAddress }) : null}
              {linked.lastCheckedAt ? (
                <span className="ml-2">{formatDateTime(linked.lastCheckedAt, format)}</span>
              ) : null}
            </p>
            {linked.status === 'ok' && !linked.lastCheckError ? (
              <p className="t-sm flex items-start gap-2">
                <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-ok-text" />
                {t('link.reached', { target: linked.hostTargetName })}
              </p>
            ) : null}
            {linked.lastCheckError ? (
              <Alert variant={linked.status === 'failed' ? 'destructive' : 'warn'}>
                {linked.lastCheckError}
              </Alert>
            ) : null}
            {linked.remote && linked.remote.checks.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <span className="t-sm font-medium">{t('remote.checks')}</span>
                <CheckList checks={linked.remote.checks} />
              </div>
            ) : null}
            {!linked.privateAddress ? (
              <Alert variant="warn">{t('link.public', { address: linked.address })}</Alert>
            ) : null}
            {linked.status === 'ok' && !linked.bindable ? (
              <Alert variant="warn">{t('link.notBindable', { address: linked.address })}</Alert>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <span className="t-sm font-medium">{t('routes.title')}</span>
              {data.routes.length === 0 ? (
                <p className="t-cap text-text-3">{t('routes.none')}</p>
              ) : (
                <RouteList
                  routes={data.routes}
                  format={format}
                  showApplication
                  showWaf={linked.proxy.capabilities.waf}
                />
              )}
            </div>
          </>
        ) : !proxy ? (
          <>
            <p className="t-sm text-text-2">{canManage ? t('card.none') : t('card.readOnly')}</p>
            {canManage ? (
              <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
                <span className="flex flex-col gap-0.5">
                  <span className="t-sm font-medium">{t('link.title')}</span>
                  <span className="help">{t('link.help')}</span>
                </span>
                {data.candidates.length === 0 ? (
                  <p className="t-cap text-text-3">{t('link.none')}</p>
                ) : (
                  <>
                    <Field label={t('link.proxy')}>
                      <Select
                        value={chosenProxyId}
                        onChange={(event) => setLinkProxyId(event.target.value)}
                      >
                        {machines.map((candidate) => (
                          <option key={candidate.proxyId} value={candidate.proxyId}>
                            {candidate.targetName} — {candidate.description}
                          </option>
                        ))}
                        {remotes.length > 0 ? (
                          <optgroup label={t('link.remoteGroup')}>
                            {remotes.map((candidate) => (
                              <option key={candidate.proxyId} value={candidate.proxyId}>
                                {candidate.description}
                              </option>
                            ))}
                          </optgroup>
                        ) : null}
                      </Select>
                    </Field>
                    <Field label={t('link.address')} help={t('link.address.help')}>
                      <Input
                        className="mono"
                        value={address}
                        placeholder="10.0.0.12"
                        onChange={(event) => setLinkAddress(event.target.value)}
                      />
                    </Field>
                  </>
                )}
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setNpmDrawer({ connection: null })}
                  >
                    <Network aria-hidden />
                    {t('action.connectNpm')}
                  </Button>
                  {data.candidates.length > 0 ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={busy === 'link'}
                      disabled={!chosenProxyId || !address.trim()}
                      onClick={() => void link(chosenProxyId, address.trim())}
                    >
                      {busy === 'link' ? null : <Link2 aria-hidden />}
                      {t('action.link')}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {detected ? (
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <span className="t-sm font-medium">{t('detect.found')}</span>
                  {detected.detections.length === 0 ? (
                    <p className="t-sm text-text-3">{t('detect.none')}</p>
                  ) : (
                    <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border">
                      {detected.detections.map((detection) => (
                        <li
                          key={`${detection.kind}:${detection.summary}`}
                          className="flex flex-wrap items-start gap-3 px-3 py-2"
                        >
                          <span className="flex min-w-0 flex-1 flex-col gap-1">
                            <span className="t-sm mono">{detection.summary}</span>
                            {detection.warnings.map((warning) => (
                              <span key={warning} className="t-cap text-warn-text">
                                {warning}
                              </span>
                            ))}
                            {detection.config ? null : (
                              <span className="t-cap text-text-3">{t('detect.unusable')}</span>
                            )}
                          </span>
                          {detection.config ? (
                            <Button
                              size="sm"
                              loading={busy === 'use'}
                              onClick={() => void use(detection)}
                            >
                              {t('action.use')}
                            </Button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="flex flex-col gap-3">
                  <span className="t-sm font-medium">{t('detect.install')}</span>
                  <ul className="flex flex-col gap-1.5">
                    {detected.installOptions.map((candidate) => (
                      <li key={optionId(candidate)}>
                        <label
                          className={`flex items-start gap-2 ${candidate.available ? '' : 'opacity-60'}`}
                        >
                          <input
                            type="radio"
                            name={`proxy-option-${targetId}`}
                            className="mt-1"
                            checked={option === optionId(candidate)}
                            disabled={!candidate.available}
                            onChange={() => choose(candidate)}
                          />
                          <span className="flex flex-col">
                            <span className="t-sm font-medium">{candidate.title}</span>
                            <span className="t-cap text-text-3">{candidate.detail}</span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                  {option ? (
                    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
                      <Field label={t('install.email')} help={t('install.email.help')}>
                        <Input
                          type="email"
                          value={email}
                          autoComplete="email"
                          onChange={(event) => setEmail(event.target.value)}
                        />
                      </Field>
                      <div className="flex flex-col gap-1.5">
                        <span className="t-sm font-medium">{t('install.server')}</span>
                        <SegmentedControl
                          label={t('install.server')}
                          value={server}
                          // Seulement les autorités que l'installation choisie sait interroger.
                          options={(
                            detected.installOptions.find(
                              (candidate) => optionId(candidate) === option,
                            )?.acmeServers ?? ['production']
                          ).map((value) => ({ value, label: t(`install.server.${value}`) }))}
                          onChange={setServer}
                        />
                        {server === 'staging' ? (
                          <span className="help">{t('install.server.staging.help')}</span>
                        ) : server === 'zerossl' ? (
                          <span className="help">{t('install.server.zerossl.help')}</span>
                        ) : server === 'custom' ? (
                          <span className="help">{t('install.server.custom.help')}</span>
                        ) : null}
                      </div>
                      {server === 'custom' ? (
                        <>
                          <Field label={t('install.customUrl')}>
                            <Input
                              className="mono"
                              value={customUrl}
                              placeholder="https://acme.interne/acme/acme/directory"
                              onChange={(event) => setCustomUrl(event.target.value)}
                            />
                          </Field>
                          <Field label={t('install.caCertificate')} optional>
                            <Textarea
                              className="mono"
                              rows={4}
                              value={caCertificate}
                              placeholder="-----BEGIN CERTIFICATE-----"
                              onChange={(event) => setCaCertificate(event.target.value)}
                            />
                          </Field>
                        </>
                      ) : null}
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setDetected(null)}>
                          {t('action.cancel')}
                        </Button>
                        <Button
                          size="sm"
                          loading={busy === 'install'}
                          disabled={!email.includes('@') || (server === 'custom' && !customUrl)}
                          onClick={() => void install()}
                        >
                          {t('action.install')}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="t-sm font-medium">{proxy.name}</span>
              <Badge variant={STATUS_VARIANT[proxy.status]} dot>
                {proxy.status === 'installing' ? (
                  <LoaderCircle aria-hidden className="size-3 animate-spin" />
                ) : null}
                {t(`status.${proxy.status}`)}
              </Badge>
              <Badge variant="idle">{proxy.managed ? t('badge.managed') : t('badge.found')}</Badge>
            </div>
            <p className="t-sm mono text-text-2">{proxy.description}</p>
            <p className="t-cap text-text-3">
              {proxy.acme
                ? t('acme.line', {
                    server: serverLabel(proxy.acme.server),
                    email: proxy.acme.email,
                  })
                : proxy.capabilities.autoTls
                  ? t('acme.own')
                  : t('acme.none')}
            </p>
            {proxy.status === 'installing' ? (
              <Alert variant="info">{t('install.running')}</Alert>
            ) : null}
            {proxy.lastCheckError && proxy.status === 'failed' ? (
              <Alert variant="destructive">{proxy.lastCheckError}</Alert>
            ) : null}

            <div className="flex flex-col gap-1.5">
              <span className="t-sm font-medium">
                {t('checks.title')}
                {proxy.lastCheckedAt ? (
                  <span className="t-cap ml-2 font-normal text-text-3">
                    {formatDateTime(proxy.lastCheckedAt, format)}
                  </span>
                ) : null}
              </span>
              {proxy.checks.length === 0 ? (
                <p className="t-cap text-text-3">
                  {pending ? (
                    <LoaderCircle aria-hidden className="mr-1 inline size-3 animate-spin" />
                  ) : null}
                  {t('checks.never')}
                </p>
              ) : (
                <CheckList checks={proxy.checks} />
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="t-sm font-medium">{t('routes.title')}</span>
              {data.routes.length === 0 ? (
                <p className="t-cap text-text-3">{t('routes.none')}</p>
              ) : (
                <RouteList
                  routes={data.routes}
                  format={format}
                  showApplication
                  hostTargetId={targetId}
                  showWaf={proxy.capabilities.waf}
                />
              )}
            </div>

            {data.served.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <span className="flex flex-col gap-0.5">
                  <span className="t-sm font-medium">{t('served.title')}</span>
                  <span className="help">{t('served.help')}</span>
                </span>
                <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border">
                  {data.served.map((entry) => (
                    <li
                      key={entry.targetId}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
                    >
                      <Link
                        href={`/targets?target=${entry.targetId}&tab=proxy`}
                        className="t-sm font-medium hover:underline"
                      >
                        {entry.targetName}
                      </Link>
                      <span className="t-cap mono text-text-3">{entry.address}</span>
                      <Badge variant={STATUS_VARIANT[entry.status]} dot>
                        {t(`link.status.${entry.status}`)}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </CardContent>

      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        level="reversible"
        title={t('remove.title', { target: targetName })}
        consequences={[t('remove.consequence')]}
        confirmLabel={t('action.remove')}
        onConfirm={async () => {
          setRemoving(false);
          const response = await call(
            `/api/targets/${targetId}/proxy?uninstall=${proxy?.managed && uninstall ? '1' : '0'}`,
            { method: 'DELETE' },
          );
          if (!response) return;
          toast({ title: t('remove.queued'), tone: 'ok' });
          watch();
        }}
      >
        {proxy?.managed ? (
          <CheckboxField
            label={t('remove.uninstall')}
            help={t('remove.uninstall.help')}
            checked={uninstall}
            onChange={(event) => setUninstall(event.target.checked)}
          />
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={unlinking}
        onOpenChange={setUnlinking}
        level="reversible"
        title={t('unlink.title', { target: targetName, via: linked?.hostTargetName ?? '' })}
        consequences={[t('unlink.consequence')]}
        confirmLabel={t('action.unlink')}
        onConfirm={async () => {
          setUnlinking(false);
          const response = await call(`/api/targets/${targetId}/proxy/link`, {
            method: 'DELETE',
          });
          if (!response) return;
          toast({ title: t('link.unlinked'), tone: 'ok' });
          await refresh();
        }}
      />

      <NpmConnectionDrawer
        open={npmDrawer !== null}
        onClose={() => setNpmDrawer(null)}
        connection={npmDrawer?.connection ?? null}
        onSaved={(proxyId) => {
          // Une connexion neuve est proposée d'emblée pour relier la machine.
          if (proxyId && !npmDrawer?.connection) setLinkProxyId(proxyId);
          void refresh();
        }}
      />
    </Card>
  );
}

/** Le test qu'on attend : celui de la machine (son proxy, ou sa liaison), ou celui d'un proxy distant. */
type CheckOf = 'machine' | 'remote';

function lastCheckedAt(data: Data, of: CheckOf = 'machine'): string | null {
  if (of === 'remote') return data.link?.remote?.lastCheckedAt ?? null;
  return data.proxy?.lastCheckedAt ?? data.link?.lastCheckedAt ?? null;
}

/** Les points d'un test, un par ligne. */
function CheckList({ checks }: { checks: ProxyViewForUi['checks'] }) {
  return (
    <ul className="flex flex-col gap-1">
      {checks.map((item) => (
        <li key={item.key} className="t-sm flex items-start gap-2">
          {item.ok ? (
            <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-ok-text" />
          ) : (
            <CircleX aria-hidden className="mt-0.5 size-4 shrink-0 text-danger-text" />
          )}
          <span>
            {item.label}
            {item.detail ? <span className="text-text-3"> — {item.detail}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Le jour seul, dans le fuseau et la langue de l'instance : une échéance de certificat. */
function formatDay(value: string, format: FormatSettings): string {
  return new Intl.DateTimeFormat(format.locale, {
    dateStyle: 'medium',
    timeZone: format.timezone,
  }).format(new Date(value));
}

/** Les domaines, avec leur état et leur certificat — la carte du proxy et celle de l'application. */
export function RouteList({
  routes,
  format,
  showApplication = false,
  hostTargetId,
  showWaf = false,
}: {
  routes: RouteViewForUi[];
  format: FormatSettings;
  showApplication?: boolean;
  /** La machine du proxy : les domaines d'une autre machine qu'il sert disent laquelle. */
  hostTargetId?: string;
  /** Le proxy est aussi un WAF : chaque domaine dit sa protection. */
  showWaf?: boolean;
}) {
  const t = useT(messages);
  return (
    <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border">
      {routes.map((route) => (
        <li key={route.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-2">
              <a href={route.url} target="_blank" rel="noreferrer" className="link mono t-sm">
                {route.hostname}
              </a>
              <Badge variant={ROUTE_VARIANT[route.status]} dot>
                {t(`route.status.${route.status}`)}
              </Badge>
              {showWaf ? (
                <Badge variant={route.waf === 'block' ? 'idle' : 'warn'}>
                  {t('route.waf', { mode: t(`waf.${route.waf}`) })}
                </Badge>
              ) : null}
              <span className="t-cap text-text-3">
                {route.certificate && route.certificate.status !== 'none'
                  ? route.certificate.status === 'valid'
                    ? t('cert.valid', {
                        date: route.certificate.notAfter
                          ? formatDay(route.certificate.notAfter, format)
                          : '?',
                      })
                    : t(`cert.${route.certificate.status}`)
                  : route.tls
                    ? ''
                    : t('cert.none')}
              </span>
            </span>
            {route.status === 'failed' && route.lastError ? (
              <span className="t-cap text-danger-text">{route.lastError}</span>
            ) : null}
          </span>
          {showApplication ? (
            <span className="t-cap text-text-3">
              <Link href={`/applications?app=${route.applicationId}`} className="link">
                {route.applicationSlug}
              </Link>
              {hostTargetId && route.targetId !== hostTargetId ? ` · ${route.targetName}` : null}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
