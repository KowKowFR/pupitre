'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { failOnLabel, failOnSchema, type ApplicationScanPolicy, type FailOn } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { useLanguage, useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { vulnerabilities as messages } from '@/i18n/messages/vulnerabilities';
import { formatDateTimeWith, type FormatSettings } from '@/lib/format';
import type { AcceptanceJson } from '@/lib/vulnerabilities';
import { toast } from '@/lib/toast';

type ApiError = { error?: { message?: string } };

/**
 * L'onglet « Sécurité » d'une application : ce qui bloque ses mises en ligne
 * — son seuil, et s'il ne vaut que pour les failles corrigeables — et les
 * failles qu'on y a acceptées. Le réglage vide reprend celui de l'instance.
 */
export function ApplicationSecurity({
  applicationId,
  applicationSlug,
  policy,
  instance,
  acceptances,
  canConfigure,
  format,
}: {
  applicationId: string;
  applicationSlug: string;
  policy: ApplicationScanPolicy;
  instance: { failOn: FailOn; onlyFixable: boolean };
  acceptances: AcceptanceJson[];
  canConfigure: boolean;
  format: FormatSettings;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const language = useLanguage();
  const router = useRouter();
  const [failOn, setFailOn] = useState<FailOn | ''>(policy.failOn ?? '');
  const [onlyFixable, setOnlyFixable] = useState<'' | 'true' | 'false'>(
    policy.onlyFixable === null ? '' : (String(policy.onlyFixable) as 'true' | 'false'),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed =
    (failOn || null) !== policy.failOn ||
    (onlyFixable === '' ? null : onlyFixable === 'true') !== policy.onlyFixable;
  const effectiveFailOn = failOn || instance.failOn;
  const effectiveFixable = onlyFixable === '' ? instance.onlyFixable : onlyFixable === 'true';

  async function save() {
    setPending(true);
    setError(null);
    const response = await fetch(`/api/applications/${applicationId}/scan-policy`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        failOn: failOn || null,
        onlyFixable: onlyFixable === '' ? null : onlyFixable === 'true',
      }),
    });
    setPending(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? tc('http.failure', { status: response.status }));
      return;
    }
    toast({ title: t('toast.policySaved', { app: applicationSlug }), tone: 'ok' });
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="card overflow-hidden">
        <div className="card-h flex-wrap">
          <h2>{t('policy.title')}</h2>
          <span className="sub">{t('policy.sub')}</span>
        </div>
        <div className="card-b flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('policy.failOn')}>
              <Select
                value={failOn}
                disabled={!canConfigure}
                onChange={(event) => setFailOn(event.target.value as FailOn | '')}
              >
                <option value="">
                  {t('policy.inherit', { value: failOnLabel(instance.failOn, language) })}
                </option>
                {failOnSchema.options.map((option) => (
                  <option key={option} value={option}>
                    {failOnLabel(option, language)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('policy.onlyFixable')}>
              <Select
                value={onlyFixable}
                disabled={!canConfigure}
                onChange={(event) => setOnlyFixable(event.target.value as '' | 'true' | 'false')}
              >
                <option value="">
                  {t('policy.inherit', {
                    value: t(`policy.onlyFixable.${instance.onlyFixable}`),
                  })}
                </option>
                <option value="true">{t('policy.onlyFixable.true')}</option>
                <option value="false">{t('policy.onlyFixable.false')}</option>
              </Select>
            </Field>
          </div>
          <p className="t-sm text-text-2">
            {t('policy.effective', {
              failOn: failOnLabel(effectiveFailOn, language),
              fixable: t(`policy.effective.fixable.${effectiveFixable}`),
            })}
          </p>
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          {canConfigure ? (
            <Button className="self-start" disabled={!changed} loading={pending} onClick={save}>
              {t('policy.save')}
            </Button>
          ) : (
            <p className="t-cap text-text-3">{t('policy.readOnly')}</p>
          )}
        </div>
      </section>

      <section className="card overflow-hidden">
        <div className="card-h flex-wrap">
          <h2>{t('acceptances.title')}</h2>
          <span className="sub">{t('acceptances.sub')}</span>
        </div>
        {acceptances.length === 0 ? (
          <p className="t-sm px-4 py-3.5 text-text-2">{t('acceptances.empty')}</p>
        ) : (
          <ul className="list">
            {acceptances.map((acceptance) => (
              <AcceptanceRow
                key={acceptance.id}
                applicationId={applicationId}
                acceptance={acceptance}
                canConfigure={canConfigure}
                format={format}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function AcceptanceRow({
  applicationId,
  acceptance,
  canConfigure,
  format,
}: {
  applicationId: string;
  acceptance: AcceptanceJson;
  canConfigure: boolean;
  format: FormatSettings;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const router = useRouter();
  const [removing, setRemoving] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const date = (value: string) =>
    formatDateTimeWith(value, format, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: format.timezone,
    });

  async function remove() {
    setPending(true);
    setError(null);
    const response = await fetch(
      `/api/applications/${applicationId}/vulnerability-acceptances/${acceptance.id}`,
      { method: 'DELETE' },
    );
    setPending(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? tc('http.failure', { status: response.status }));
      return;
    }
    setRemoving(false);
    toast({ title: t('toast.acceptanceRemoved', { cve: acceptance.cveId }), tone: 'ok' });
    router.refresh();
  }

  return (
    <li className="flex-col !items-stretch gap-1.5 !py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mono text-[12.5px] font-medium text-text">{acceptance.cveId}</span>
        <span className="mono t-cap text-text-2">
          {acceptance.package ?? t('acceptances.anyPackage')}
        </span>
        {acceptance.expired ? (
          <Badge variant="warn">
            {t('acceptances.expired', { date: date(acceptance.expiresAt ?? acceptance.createdAt) })}
          </Badge>
        ) : (
          <Badge variant="outline">
            {acceptance.expiresAt
              ? t('acceptances.expires', { date: date(acceptance.expiresAt) })
              : t('acceptances.never')}
          </Badge>
        )}
        {canConfigure ? (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setRemoving(true)}>
            <Trash2 aria-hidden />
            {t('acceptances.remove')}
          </Button>
        ) : null}
      </div>
      <p className="t-sm whitespace-pre-line text-text">{acceptance.reason}</p>
      {acceptance.authorName ? (
        <span className="t-cap text-text-3">
          {t('acceptances.by', { name: acceptance.authorName })} · {date(acceptance.createdAt)}
        </span>
      ) : null}
      <ConfirmDialog
        open={removing}
        onOpenChange={(open) => (open ? undefined : setRemoving(false))}
        level="trace"
        title={t('acceptances.confirm.title', { cve: acceptance.cveId })}
        consequences={[t('acceptances.confirm.consequence')]}
        confirmLabel={t('acceptances.confirm.action')}
        pending={pending}
        error={error}
        onConfirm={remove}
      />
    </li>
  );
}
