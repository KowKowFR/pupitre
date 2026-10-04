'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, Globe, RefreshCw } from 'lucide-react';
import { domainInspectionSchema, type DomainInspection } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { KeyValue } from '@/components/ui/data';
import {
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerSection,
  useDrawerSelection,
} from '@/components/ui/drawer';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { domains as messages } from '@/i18n/messages/domains';
import { proxy as proxyMessages } from '@/i18n/messages/proxy';
import type { DomainRow } from '@/lib/domains';
import { formatDateTimeWith, type FormatSettings } from '@/lib/format';

const STATUS_VARIANT = { pending: 'idle', active: 'ok', failed: 'danger' } as const;

/** A row, with "3 min ago" already computed on the server (no hydration mismatch). */
export type DomainViewRow = DomainRow & { checked: string };

type ApiError = { error?: { message?: string } };

/**
 * The domains table and a domain's drawer. The drawer follows the URL
 * (`?domaine=…`): J/K move from one domain to the next, and the link can be
 * shared.
 */
export function DomainsView({ rows, format }: { rows: DomainViewRow[]; format: FormatSettings }) {
  const t = useT(messages);
  const tp = useT(proxyMessages);
  const drawer = useDrawerSelection(
    'domaine',
    rows.map((row) => row.id),
  );
  const current = rows.find((row) => row.id === drawer.selected) ?? null;

  return (
    <>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('column.domain')}</TableHead>
              <TableHead>{t('column.application')}</TableHead>
              <TableHead>{t('column.machine')}</TableHead>
              <TableHead>{t('column.proxy')}</TableHead>
              <TableHead>{t('column.status')}</TableHead>
              <TableHead>{t('column.certificate')}</TableHead>
              <TableHead>{t('column.checked')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow
                key={row.id}
                interactive
                selected={drawer.selected === row.id}
                onClick={() => drawer.open(row.id)}
              >
                <TableCell>
                  <span className="flex flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="mono text-left font-medium whitespace-nowrap text-text hover:underline"
                        aria-label={t('row.open', { hostname: row.hostname })}
                        onClick={(event) => {
                          event.stopPropagation();
                          drawer.open(row.id);
                        }}
                      >
                        {row.hostname}
                      </button>
                      {row.proxy?.waf ? (
                        <Badge variant={row.waf === 'block' ? 'idle' : 'warn'}>
                          {tp('route.waf', { mode: tp(`waf.${row.waf}`) })}
                        </Badge>
                      ) : null}
                    </span>
                    {row.status === 'failed' && row.lastError ? (
                      <span className="t-cap text-danger-text">{row.lastError}</span>
                    ) : null}
                  </span>
                </TableCell>
                <TableCell>
                  <Link
                    href={`/applications?app=${row.applicationId}`}
                    className="link whitespace-nowrap"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {row.applicationSlug}
                  </Link>
                </TableCell>
                <TableCell>
                  <Link
                    href={`/targets?target=${row.targetId}`}
                    className="link whitespace-nowrap"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {row.targetName}
                  </Link>
                </TableCell>
                <TableCell className="t-cap text-text-2">
                  <ProxyCell row={row} />
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[row.status]} dot>
                    {tp(`route.status.${row.status}`)}
                  </Badge>
                </TableCell>
                <TableCell>
                  <CertificateCell row={row} format={format} />
                </TableCell>
                <TableCell className="t-cap text-text-3">{row.checked}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <Drawer
        open={current !== null}
        onOpenChange={(open) => (open ? undefined : drawer.close())}
        onPrevious={drawer.onPrevious}
        onNext={drawer.onNext}
        wide
        label={current?.hostname}
      >
        {current ? <DomainDrawer key={current.id} row={current} format={format} /> : null}
      </Drawer>
    </>
  );
}

function ProxyCell({ row }: { row: DomainViewRow }) {
  const t = useT(messages);
  if (!row.proxy) return <span className="text-text-3">{t('proxy.none')}</span>;
  return (
    <>
      {row.proxy.description}
      {row.via ? (
        <span className="block text-text-3">{t('proxy.via', { target: row.via })}</span>
      ) : null}
    </>
  );
}

/** A certificate's expiry, and the time it has left — in color when it is pressing. */
function CertificateCell({ row, format }: { row: DomainViewRow; format: FormatSettings }) {
  const t = useT(messages);
  const tp = useT(proxyMessages);
  if (!row.tls) return <span className="t-cap text-text-3">{t('cert.http')}</span>;
  const certificate = row.certificate;
  // Not probed yet: the certificate may be being issued. Probed without a
  // certificate — a domain that does not answer —, there is nothing to say about it.
  if (!certificate || certificate.status === 'none') {
    return (
      <span className="t-cap text-text-3">
        {row.status === 'pending' ? tp('cert.pending') : '—'}
      </span>
    );
  }
  if (certificate.status !== 'valid' || !certificate.notAfter) {
    return (
      <span
        className={
          certificate.status === 'invalid' ? 't-cap text-danger-text' : 't-cap text-text-3'
        }
      >
        {tp(`cert.${certificate.status}`)}
      </span>
    );
  }
  const days = row.certificateDaysLeft;
  const date = formatDateTimeWith(certificate.notAfter, format, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: format.timezone,
  });
  return (
    <span className="flex flex-col gap-0.5">
      <span className="t-cap text-text-2">{t('cert.until', { date })}</span>
      <DaysLeft days={days} expired={row.certificateExpired} urgent={row.attention} />
    </span>
  );
}

function DaysLeft({
  days,
  expired,
  urgent,
}: {
  days: number | null;
  expired: boolean;
  urgent: boolean;
}) {
  const t = useT(messages);
  if (days === null) return null;
  if (expired) {
    return (
      <Badge variant="danger">
        {days === 0 ? t('cert.expiredToday') : t('cert.expired', { count: -days })}
      </Badge>
    );
  }
  if (days === 0) return <Badge variant="danger">{t('cert.today')}</Badge>;
  if (urgent) return <Badge variant="warn">{t('cert.daysLeft', { count: days })}</Badge>;
  return <span className="t-cap text-text-3">{t('cert.daysLeft', { count: days })}</span>;
}

type Lookup =
  | { state: 'loading' }
  | { state: 'ready'; inspection: DomainInspection }
  | { state: 'failed'; error: string };

/**
 * A domain's reading, asked of the panel. A pure function: it returns the state
 * to set, and it is the caller that sets it — never in an effect's body. `null`:
 * the request was abandoned (drawer closed).
 */
async function fetchInspection(
  id: string,
  failure: (status: number) => string,
  signal?: AbortSignal,
): Promise<Lookup | null> {
  try {
    const response = await fetch(`/api/domains/${id}/inspect`, { signal });
    const body = (await response.json().catch(() => ({}))) as unknown;
    if (!response.ok) {
      return {
        state: 'failed',
        error: (body as ApiError).error?.message ?? failure(response.status),
      };
    }
    const parsed = domainInspectionSchema.safeParse(body);
    return parsed.success
      ? { state: 'ready', inspection: parsed.data }
      : { state: 'failed', error: failure(response.status) };
  } catch (error) {
    if ((error as Error).name === 'AbortError') return null;
    return { state: 'failed', error: (error as Error).message };
  }
}

/**
 * A domain in detail. What the database knows shows right away; the reading —
 * DNS, addresses, registry, certificate — arrives from the worker a few seconds
 * later, and is started again with a button.
 */
function DomainDrawer({ row, format }: { row: DomainViewRow; format: FormatSettings }) {
  const t = useT(messages);
  const tp = useT(proxyMessages);
  const c = useT(common);
  const [lookup, setLookup] = useState<Lookup>({ state: 'loading' });
  const failure = useCallback((status: number) => c('http.failure', { status }), [c]);
  const day = (value: string | null) =>
    value
      ? formatDateTimeWith(value, format, {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          timeZone: format.timezone,
        })
      : c('none');

  useEffect(() => {
    const controller = new AbortController();
    fetchInspection(row.id, failure, controller.signal).then((result) => {
      if (result) setLookup(result);
    });
    return () => controller.abort();
  }, [row.id, failure]);

  function retry() {
    setLookup({ state: 'loading' });
    void fetchInspection(row.id, failure).then((result) => {
      if (result) setLookup(result);
    });
  }

  const certificate = row.certificate;

  return (
    <>
      <DrawerHeader
        icon={<Globe />}
        kind={t('drawer.kind')}
        route={row.url}
        title={<span className="mono">{row.hostname}</span>}
        state={
          <>
            <Badge variant={STATUS_VARIANT[row.status]} dot>
              {tp(`route.status.${row.status}`)}
            </Badge>
            {row.proxy?.waf ? (
              <Badge variant={row.waf === 'block' ? 'idle' : 'warn'}>
                {tp('route.waf', { mode: tp(`waf.${row.waf}`) })}
              </Badge>
            ) : null}
            {row.tls && certificate?.status === 'valid' ? (
              <DaysLeft
                days={row.certificateDaysLeft}
                expired={row.certificateExpired}
                urgent={row.attention}
              />
            ) : null}
          </>
        }
      />
      <DrawerBody>
        <DrawerSection title={t('drawer.service')}>
          <KeyValue
            items={[
              {
                key: 'application',
                term: t('drawer.application'),
                value: (
                  <Link href={`/applications?app=${row.applicationId}`} className="link">
                    {row.applicationSlug}
                  </Link>
                ),
              },
              {
                key: 'machine',
                term: t('drawer.machine'),
                value: (
                  <Link href={`/targets?target=${row.targetId}`} className="link">
                    {row.targetName}
                  </Link>
                ),
              },
              { key: 'proxy', term: t('drawer.proxy'), value: <ProxyCell row={row} /> },
              {
                key: 'protocol',
                term: t('drawer.protocol'),
                value: !row.tls
                  ? t('drawer.protocol.http')
                  : row.redirectHttps
                    ? t('drawer.protocol.httpsRedirect')
                    : t('drawer.protocol.https'),
              },
              ...(row.tls && certificate && certificate.status !== 'none'
                ? [
                    {
                      key: 'proxyCertificate',
                      term: t('drawer.proxyCertificate'),
                      value: (
                        <span className="flex flex-col">
                          <span>
                            {certificate.status === 'valid' && certificate.notAfter
                              ? t('cert.until', { date: day(certificate.notAfter) })
                              : tp(
                                  `cert.${certificate.status === 'valid' ? 'unknown' : certificate.status}`,
                                )}
                          </span>
                          {certificate.issuer ? (
                            <span className="t-cap text-text-3">{certificate.issuer}</span>
                          ) : null}
                        </span>
                      ),
                    },
                  ]
                : []),
              { key: 'checked', term: t('drawer.checked'), value: row.checked },
              ...(row.lastError
                ? [
                    {
                      key: 'lastError',
                      term: t('drawer.lastError'),
                      value: <span className="t-sm text-danger-text">{row.lastError}</span>,
                    },
                  ]
                : []),
            ]}
          />
        </DrawerSection>

        {lookup.state === 'loading' ? (
          <section className="dr-sec" aria-busy="true">
            <p className="t-sm text-text-3">{t('drawer.loading')}</p>
            <div className="flex flex-col gap-2">
              <Skeleton variant="text" className="w-3/4" />
              <Skeleton variant="text" className="w-1/2" />
              <Skeleton variant="text" className="w-2/3" />
            </div>
          </section>
        ) : lookup.state === 'failed' ? (
          <Alert variant="destructive">{lookup.error}</Alert>
        ) : (
          <Inspection inspection={lookup.inspection} format={format} />
        )}
      </DrawerBody>
      <DrawerFooter
        end={
          <Button asChild variant="ghost">
            <Link href={`/applications?app=${row.applicationId}`}>
              {t('drawer.record')}
              <ArrowUpRight aria-hidden />
            </Link>
          </Button>
        }
      >
        <Button variant="secondary" loading={lookup.state === 'loading'} onClick={retry}>
          <RefreshCw aria-hidden />
          {t('drawer.retry')}
        </Button>
        <Button asChild variant="ghost">
          <a href={row.url} target="_blank" rel="noreferrer">
            {t('drawer.open')}
            <ArrowUpRight aria-hidden />
          </a>
        </Button>
      </DrawerFooter>
    </>
  );
}

/** A list of technical values, one per line. */
function Values({ values, empty }: { values: string[]; empty?: string }) {
  const c = useT(common);
  if (values.length === 0) return <span className="text-text-3">{empty ?? c('none')}</span>;
  return (
    <span className="flex flex-col">
      {values.map((value) => (
        <span key={value} className="mono t-sm break-all">
          {value}
        </span>
      ))}
    </span>
  );
}

function Inspection({
  inspection,
  format,
}: {
  inspection: DomainInspection;
  format: FormatSettings;
}) {
  const t = useT(messages);
  const c = useT(common);
  const { dns, zone, addresses, pointing, registration, certificate } = inspection;
  const day = (value: string | null) =>
    value
      ? formatDateTimeWith(value, format, {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          timeZone: format.timezone,
        })
      : c('none');
  const time = formatDateTimeWith(inspection.checkedAt, format, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: format.timezone,
  });

  return (
    <>
      <DrawerSection
        title={t('dns.title')}
        aside={
          pointing.status === 'match' ? (
            <Badge variant="ok" dot className="ml-auto">
              {t('pointing.match')}
            </Badge>
          ) : pointing.status === 'mismatch' ? (
            <Badge variant="warn" dot className="ml-auto">
              {t('pointing.mismatch')}
            </Badge>
          ) : null
        }
      >
        {dns.status === 'error' ? (
          <Alert variant="destructive">{t('dns.error', { error: dns.error ?? '' })}</Alert>
        ) : dns.status === 'not_found' ? (
          <Alert variant="warn">{t('dns.notFound')}</Alert>
        ) : (
          <KeyValue
            items={[
              ...(dns.cname.length > 0
                ? [{ key: 'cname', term: t('dns.cname'), value: <Values values={dns.cname} /> }]
                : []),
              { key: 'a', term: t('dns.a'), value: <Values values={dns.a} /> },
              { key: 'aaaa', term: t('dns.aaaa'), value: <Values values={dns.aaaa} /> },
              ...(dns.ttl !== null
                ? [
                    {
                      key: 'ttl',
                      term: t('dns.ttl'),
                      value: (
                        <span className="mono">{t('dns.ttl.value', { seconds: dns.ttl })}</span>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
        {pointing.status === 'mismatch' ? (
          <p className="t-cap text-text-3">
            {t('pointing.mismatch.hint', { expected: pointing.expected.join(', ') })}
          </p>
        ) : pointing.status === 'unknown' && dns.status === 'ok' ? (
          <p className="t-cap text-text-3">{t('pointing.unknown')}</p>
        ) : null}
      </DrawerSection>

      {addresses.length > 0 ? (
        <DrawerSection title={t('addresses.title')}>
          <ul className="flex flex-col divide-y divide-border-subtle rounded-[10px] border border-border">
            {addresses.map((entry) => (
              <li
                key={entry.address}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
              >
                <span className="mono t-sm break-all text-text">{entry.address}</span>
                <Badge variant={entry.scope === 'public' ? 'outline' : 'idle'}>
                  {entry.scope ? t(`scope.${entry.scope}`) : `IPv${entry.family}`}
                </Badge>
                <span className="t-cap ml-auto min-w-0 text-text-3">
                  {entry.reverse.length > 0 ? (
                    <span className="mono">{entry.reverse.join(', ')}</span>
                  ) : (
                    t('addresses.noReverse')
                  )}
                </span>
              </li>
            ))}
          </ul>
        </DrawerSection>
      ) : null}

      <DrawerSection title={t('registration.title')}>
        {registration.status === 'ok' ? (
          <KeyValue
            items={[
              {
                key: 'domain',
                term: t('registration.domain'),
                value: <span className="mono">{registration.domain}</span>,
              },
              {
                key: 'registrar',
                term: t('registration.registrar'),
                value: registration.registrar ?? c('none'),
              },
              {
                key: 'registeredOn',
                term: t('registration.registeredOn'),
                value: day(registration.registeredOn),
              },
              {
                key: 'expiresOn',
                term: t('registration.expiresOn'),
                value: (
                  <span className="flex flex-wrap items-center justify-end gap-2">
                    {day(registration.expiresOn)}
                    <DaysLeft
                      days={registration.daysRemaining}
                      expired={(registration.daysRemaining ?? 0) < 0}
                      urgent={(registration.daysRemaining ?? Infinity) < 30}
                    />
                  </span>
                ),
              },
              {
                key: 'lastChangedOn',
                term: t('registration.lastChangedOn'),
                value: day(registration.lastChangedOn),
              },
              {
                key: 'nameservers',
                term: t('registration.nameservers'),
                value: <Values values={registration.nameservers} />,
              },
              ...(registration.statuses.length > 0
                ? [
                    {
                      key: 'statuses',
                      term: t('registration.statuses'),
                      value: (
                        <span className="flex flex-wrap justify-end gap-1">
                          {registration.statuses.map((status) => (
                            <Badge key={status} variant="outline" className="mono">
                              {status}
                            </Badge>
                          ))}
                        </span>
                      ),
                    },
                  ]
                : []),
              {
                key: 'server',
                term: t('registration.server'),
                value: <span className="mono t-cap">{registration.server}</span>,
              },
            ]}
          />
        ) : (
          <p className="t-sm text-text-2">
            {registration.status === 'not_found'
              ? t('registration.notFound', {
                  server: registration.server ?? '',
                  domain: registration.domain ?? '',
                })
              : registration.status === 'error'
                ? t('registration.error', { error: registration.error ?? '' })
                : t(`registration.${registration.status}`)}
          </p>
        )}
      </DrawerSection>

      {zone && (zone.ns.length > 0 || zone.mx.length > 0 || zone.caa.length > 0) ? (
        <DrawerSection title={t('zone.title', { name: zone.name })}>
          <KeyValue
            items={[
              { key: 'ns', term: t('zone.ns'), value: <Values values={zone.ns} /> },
              { key: 'mx', term: t('zone.mx'), value: <Values values={zone.mx} /> },
              {
                key: 'caa',
                term: t('zone.caa'),
                value: <Values values={zone.caa} empty={t('zone.caa.none')} />,
              },
            ]}
          />
        </DrawerSection>
      ) : null}

      <DrawerSection title={t('certificate.title')}>
        {certificate.status === 'ok' ? (
          <KeyValue
            items={[
              {
                key: 'subject',
                term: t('certificate.subject'),
                value: <span className="mono">{certificate.subject ?? c('none')}</span>,
              },
              {
                key: 'altNames',
                term: t('certificate.altNames'),
                value: <Values values={certificate.altNames.slice(0, 12)} />,
              },
              {
                key: 'issuer',
                term: t('certificate.issuer'),
                value:
                  [certificate.issuer, certificate.issuerOrganization]
                    .filter((part, index, all) => part && all.indexOf(part) === index)
                    .join(' · ') || c('none'),
              },
              {
                key: 'validity',
                term: t('certificate.validity'),
                value: (
                  <span className="flex flex-wrap items-center justify-end gap-2">
                    {t('certificate.validity.range', {
                      from: day(certificate.validFrom),
                      to: day(certificate.validTo),
                    })}
                    <DaysLeft
                      days={certificate.daysRemaining}
                      expired={(certificate.daysRemaining ?? 0) < 0}
                      urgent={(certificate.daysRemaining ?? Infinity) < 14}
                    />
                  </span>
                ),
              },
              {
                key: 'chain',
                term: t('certificate.chain'),
                value: certificate.authorized ? (
                  <Badge variant="ok" dot>
                    {t('certificate.chain.ok')}
                  </Badge>
                ) : (
                  <Badge variant="danger" dot>
                    {t('certificate.chain.ko', { error: certificate.authorizationError ?? '' })}
                  </Badge>
                ),
              },
              {
                key: 'tls',
                term: t('certificate.tls'),
                value: (
                  <span className="mono t-sm">
                    {[certificate.protocol, certificate.cipher].filter(Boolean).join(' · ')}
                  </span>
                ),
              },
              {
                key: 'address',
                term: t('certificate.address'),
                value: <span className="mono t-sm">{certificate.address}</span>,
              },
              {
                key: 'serial',
                term: t('certificate.serial'),
                value: <span className="mono t-cap break-all">{certificate.serialNumber}</span>,
              },
              {
                key: 'fingerprint',
                term: t('certificate.fingerprint'),
                value: <span className="mono t-cap break-all">{certificate.fingerprint256}</span>,
              },
            ]}
          />
        ) : (
          <p className="t-sm text-text-2">
            {certificate.status === 'http'
              ? t('certificate.http')
              : certificate.status === 'blocked'
                ? t('certificate.blocked', { error: certificate.error ?? '' })
                : t('certificate.error', { error: certificate.error ?? '' })}
          </p>
        )}
      </DrawerSection>

      <p className="t-cap text-text-3">{t('drawer.seenFrom', { when: time })}</p>
    </>
  );
}
