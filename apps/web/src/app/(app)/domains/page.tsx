import type { Metadata } from 'next';
import Link from 'next/link';
import { Globe } from 'lucide-react';
import type { Translate } from '@pupitre/core';
import { getAppSettingsValue } from '@pupitre/db';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { LiveRefresh } from '@/components/realtime/live-refresh';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SegmentedLinks } from '@/components/ui/segmented';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { common } from '@/i18n/messages/common';
import { domains as messages } from '@/i18n/messages/domains';
import { proxy as proxyMessages } from '@/i18n/messages/proxy';
import { getT } from '@/i18n/server';
import { listDomains, type DomainRow } from '@/lib/domains';
import { formatDateTimeWith, formatSettingsOf, type FormatSettings } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import { relativeTime } from '@/lib/relative-time';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT(messages))('meta.title') };
}

export const dynamic = 'force-dynamic';

const STATUS_VARIANT = { pending: 'idle', active: 'ok', failed: 'danger' } as const;

/**
 * « Domaines » : tous les noms de l'instance sur un seul écran, avec le proxy
 * qui les sert, leur état et l'échéance de leur certificat. La fiche d'une
 * application en montre les siens ; cette page répond à la question de
 * l'exploitant — « qu'est-ce qui, quelque part, ne répond pas ou va expirer ? ».
 *
 * Rien ne s'y modifie : un domaine se règle sur la fiche de son application,
 * là où l'on voit aussi ce qu'il sert.
 */
export default async function DomainsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePagePermission('/domains', 'application:read');
  const [t, tp, tc, settings, rows] = await Promise.all([
    getT(messages),
    getT(proxyMessages),
    getT(common),
    getAppSettingsValue(),
    listDomains(),
  ]);
  const format = formatSettingsOf(settings);
  const watching = (await searchParams).filtre === 'surveiller';
  const attention = rows.filter((row) => row.attention);
  const shown = watching ? attention : rows;

  return (
    <>
      <LiveRefresh topics={['applications']} />
      <PageHeader
        title={t('page.title')}
        description={t('page.description')}
        actions={
          rows.length > 0 ? (
            <SegmentedLinks
              label={t('filter.label')}
              options={[
                {
                  href: '/domains',
                  label: t('filter.all', { count: rows.length }),
                  active: !watching,
                },
                {
                  href: '/domains?filtre=surveiller',
                  label: t('filter.attention', { count: attention.length }),
                  active: watching,
                },
              ]}
            />
          ) : null
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={Globe}
          title={t('empty.title')}
          hint={t('empty.hint')}
          action={
            <Button asChild variant="secondary">
              <Link href="/applications">{t('empty.action')}</Link>
            </Button>
          }
        />
      ) : shown.length === 0 ? (
        <EmptyState
          icon={Globe}
          title={t('empty.attention.title')}
          hint={t('empty.attention.hint')}
        />
      ) : (
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
              {shown.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <span className="flex flex-col gap-0.5">
                      <span className="flex flex-wrap items-center gap-2">
                        <a
                          href={row.url}
                          target="_blank"
                          rel="noreferrer"
                          className="link mono whitespace-nowrap"
                        >
                          {row.hostname}
                        </a>
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
                      href={`/applications/${row.applicationId}`}
                      className="link whitespace-nowrap"
                    >
                      {row.applicationSlug}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/targets/${row.targetId}`} className="link whitespace-nowrap">
                      {row.targetName}
                    </Link>
                  </TableCell>
                  <TableCell className="t-cap text-text-2">
                    {row.proxy ? (
                      <>
                        {row.proxy.description}
                        {row.via ? (
                          <span className="block text-text-3">
                            {t('proxy.via', { target: row.via })}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-text-3">{t('proxy.none')}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[row.status]} dot>
                      {tp(`route.status.${row.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Certificate row={row} format={format} t={t} tp={tp} />
                  </TableCell>
                  <TableCell className="t-cap text-text-3">
                    {relativeTime(row.lastCheckedAt, tc) ?? t('checked.never')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </>
  );
}

/** L'échéance d'un certificat, et le temps qu'il lui reste — en couleur quand il presse. */
function Certificate({
  row,
  format,
  t,
  tp,
}: {
  row: DomainRow;
  format: FormatSettings;
  t: Translate<typeof messages.fr>;
  tp: Translate<typeof proxyMessages.fr>;
}) {
  if (!row.tls) return <span className="t-cap text-text-3">{t('cert.http')}</span>;
  const certificate = row.certificate;
  // Pas encore sondé : le certificat est peut-être en cours d'émission. Sondé
  // sans certificat — un domaine qui ne répond pas —, il n'y a rien à en dire.
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
  });
  return (
    <span className="flex flex-col gap-0.5">
      <span className="t-cap text-text-2">{t('cert.until', { date })}</span>
      {days === null ? null : row.certificateExpired ? (
        <Badge variant="danger">
          {days === 0 ? t('cert.expiredToday') : t('cert.expired', { count: -days })}
        </Badge>
      ) : days === 0 ? (
        <Badge variant="danger">{t('cert.today')}</Badge>
      ) : row.attention ? (
        <Badge variant="warn">{t('cert.daysLeft', { count: days })}</Badge>
      ) : (
        <span className="t-cap text-text-3">{t('cert.daysLeft', { count: days })}</span>
      )}
    </span>
  );
}
