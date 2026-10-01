'use client';

import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle, Pencil } from 'lucide-react';
import { DomainsField, toRouteInputs, type DomainDraft } from '@/components/proxy/domains-field';
import { RouteList } from '@/components/proxy/proxy-panel';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { proxy as messages } from '@/i18n/messages/proxy';
import type { ProxyViewForUi, RouteViewForUi } from '@/lib/proxy';
import type { FormatSettings } from '@/lib/format';
import { toast } from '@/lib/toast';

/**
 * Les domaines d'une application, cible par cible : leur état à travers le
 * reverse proxy, leur certificat, et leur modification — posée aussitôt sur le
 * proxy si l'application tourne, sans la redéployer.
 */

type TargetDomains = {
  id: string;
  name: string;
  live: boolean;
  proxy: ProxyViewForUi | null;
  routes: RouteViewForUi[];
};
type Data = { defaultHost: string | null; targets: TargetDomains[] };
type ApiError = { error?: { message?: string } };

export function ApplicationDomains({
  applicationId,
  canEdit,
  format,
}: {
  applicationId: string;
  canEdit: boolean;
  format: FormatSettings;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const [data, setData] = useState<Data | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<DomainDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [watchUntil, setWatchUntil] = useState(0);

  const load = useCallback(async () => {
    const response = await fetch(`/api/applications/${applicationId}/routes`, {
      cache: 'no-store',
    }).catch(() => null);
    if (!response?.ok) return null;
    return (await response.json()) as Data;
  }, [applicationId]);

  useEffect(() => {
    let cancelled = false;
    void load().then((next) => {
      if (!cancelled && next) setData(next);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  // Après « Enregistrer » : les domaines sont posés puis éprouvés par la file —
  // on relit quelques secondes, le temps qu'ils passent de « en attente » à leur état.
  const watching = watchUntil > 0;
  useEffect(() => {
    if (!watching) return;
    const timer = window.setInterval(() => {
      void load().then((next) => {
        if (next) setData(next);
        const pending = next?.targets.some((target) =>
          target.routes.some((route) => route.status === 'pending'),
        );
        if (!pending || Date.now() > watchUntil) setWatchUntil(0);
      });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [watching, watchUntil, load]);

  async function save(target: TargetDomains) {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/applications/${applicationId}/routes`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetId: target.id, routes: toRouteInputs(draft) }),
    }).catch(() => null);
    setBusy(false);
    if (!response?.ok) {
      const body = response ? ((await response.json().catch(() => ({}))) as ApiError) : {};
      setError(body.error?.message ?? tc('http.failure', { status: response?.status ?? 0 }));
      return;
    }
    const body = (await response.json()) as { jobId: string | null };
    toast(
      body.jobId
        ? { title: t('domains.applied'), description: t('domains.applied.detail'), tone: 'ok' }
        : { title: t('domains.saved'), description: t('domains.waiting'), tone: 'ok' },
    );
    setEditing(null);
    setWatchUntil(Date.now() + 60_000);
    const next = await load();
    if (next) setData(next);
  }

  if (!data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('domains.title')}</CardTitle>
          <CardDescription>
            <LoaderCircle aria-hidden className="inline size-3.5 animate-spin" />
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('domains.title')}</CardTitle>
        <CardDescription>{t('domains.card.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        {data.targets.length === 0 ? (
          <p className="t-sm text-text-3">{t('domains.card.empty')}</p>
        ) : (
          data.targets.map((target) => (
            <div key={target.id} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="t-sm font-medium">
                  {target.name}
                  {target.proxy ? (
                    <span className="t-cap mono ml-2 font-normal text-text-3">
                      {target.proxy.description}
                    </span>
                  ) : null}
                </span>
                {canEdit && target.proxy && editing !== target.id ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setDraft(
                        target.routes.length > 0
                          ? target.routes.map((route) => ({
                              hostname: route.hostname,
                              tls: route.tls,
                            }))
                          : [
                              {
                                hostname: data.defaultHost ?? '',
                                tls: target.proxy?.capabilities.https ?? false,
                              },
                            ],
                      );
                      setEditing(target.id);
                    }}
                  >
                    <Pencil aria-hidden />
                    {t('domains.card.edit')}
                  </Button>
                ) : null}
              </div>
              {editing === target.id ? (
                <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
                  <DomainsField
                    targetId={target.id}
                    targetName={target.name}
                    proxy={target.proxy}
                    value={draft}
                    onChange={setDraft}
                    disabled={busy}
                  />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                      {t('action.cancel')}
                    </Button>
                    <Button size="sm" loading={busy} onClick={() => void save(target)}>
                      {t('domains.save')}
                    </Button>
                  </div>
                </div>
              ) : target.routes.length > 0 ? (
                <RouteList routes={target.routes} format={format} />
              ) : (
                <p className="t-cap text-text-3">
                  {target.proxy ? t('routes.none') : t('domains.noProxy')}
                </p>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
