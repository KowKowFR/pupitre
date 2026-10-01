'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { CircleCheck, CircleX, LoaderCircle, PlugZap, ScanSearch, Trash2 } from 'lucide-react';
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
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { proxy as messages } from '@/i18n/messages/proxy';
import type { ProxyViewForUi, RouteViewForUi } from '@/lib/proxy';
import { formatDateTime, type FormatSettings } from '@/lib/format';
import { toast } from '@/lib/toast';

/**
 * Le reverse proxy d'une machine : le trouver, l'installer, le tester, le
 * retirer, et voir les domaines qui passent par lui. Sur la page de la cible
 * et dans l'assistant de démarrage — le même composant aux deux endroits.
 *
 * La carte se lit elle-même et se relit tant qu'une installation ou un test
 * est en cours : ils prennent de quelques secondes à deux minutes.
 */

type Data = { proxy: ProxyViewForUi | null; routes: RouteViewForUi[] };
type Detected = { detections: ProxyDetection[]; installOptions: ProxyInstallOption[] };
type ApiError = { error?: { message?: string } };
type AcmeServer = 'production' | 'staging' | 'custom';

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
  const [watching, setWatching] = useState(false);

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

  useEffect(() => {
    if (data) onProxyChange?.(data.proxy);
  }, [data, onProxyChange]);

  // Une installation ou un test en cours : on relit jusqu'à leur issue.
  const pending = data?.proxy?.status === 'installing' || watching;
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => {
      void refresh().then((next) => {
        if (next && next.proxy?.status !== 'installing' && next.proxy?.lastCheckedAt)
          setWatching(false);
        if (next && !next.proxy) setWatching(false);
      });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [pending, refresh]);

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
    setOption(body.installOptions.find((candidate) => candidate.available)?.key ?? null);
  }

  async function use(detection: ProxyDetection) {
    setBusy('use');
    const response = await call(`/api/targets/${targetId}/proxy`, {
      method: 'PUT',
      body: JSON.stringify({ kind: 'traefik', config: detection.config }),
    });
    setBusy(null);
    if (!response) return;
    toast({ title: t('connected'), tone: 'ok' });
    setDetected(null);
    setWatching(true);
    await refresh();
  }

  async function install() {
    if (!option) return;
    setBusy('install');
    const response = await call(`/api/targets/${targetId}/proxy/install`, {
      method: 'POST',
      body: JSON.stringify({
        option,
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
    setWatching(true);
    await refresh();
  }

  async function check() {
    setBusy('check');
    const response = await call(`/api/targets/${targetId}/proxy/check`, { method: 'POST' });
    setBusy(null);
    if (!response) return;
    toast({ title: t('checks.queued'), tone: 'accent' });
    setWatching(true);
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
  const serverLabel = (value: string) =>
    value === 'production' || value === 'staging' || value === 'custom'
      ? t(`install.server.${value}`)
      : value;

  return (
    <Card>
      <CardHeader
        actions={
          canManage ? (
            proxy ? (
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

        {!proxy ? (
          <>
            <p className="t-sm text-text-2">{canManage ? t('card.none') : t('card.readOnly')}</p>
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
                          key={detection.summary}
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
                      <li key={candidate.key}>
                        <label
                          className={`flex items-start gap-2 ${candidate.available ? '' : 'opacity-60'}`}
                        >
                          <input
                            type="radio"
                            name={`proxy-option-${targetId}`}
                            className="mt-1"
                            checked={option === candidate.key}
                            disabled={!candidate.available}
                            onChange={() => setOption(candidate.key)}
                          />
                          <span className="flex flex-col">
                            <span className="t-sm font-medium">
                              {candidate.key === 'kubernetes'
                                ? t('install.kubernetes')
                                : t('install.container')}
                            </span>
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
                          options={[
                            { value: 'production', label: t('install.server.production') },
                            { value: 'staging', label: t('install.server.staging') },
                            { value: 'custom', label: t('install.server.custom') },
                          ]}
                          onChange={setServer}
                        />
                        {server === 'staging' ? (
                          <span className="help">{t('install.server.staging.help')}</span>
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
                : proxy.certResolver
                  ? proxy.description
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
                <ul className="flex flex-col gap-1">
                  {proxy.checks.map((item) => (
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
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="t-sm font-medium">{t('routes.title')}</span>
              {data.routes.length === 0 ? (
                <p className="t-cap text-text-3">{t('routes.none')}</p>
              ) : (
                <RouteList routes={data.routes} format={format} showApplication />
              )}
            </div>
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
          setWatching(true);
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
    </Card>
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
}: {
  routes: RouteViewForUi[];
  format: FormatSettings;
  showApplication?: boolean;
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
            <Link href={`/applications/${route.applicationId}`} className="link t-cap">
              {route.applicationSlug}
            </Link>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
