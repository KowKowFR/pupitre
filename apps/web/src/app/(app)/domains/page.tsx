import type { Metadata } from 'next';
import Link from 'next/link';
import { Globe } from 'lucide-react';
import { getAppSettingsValue } from '@pupitre/db';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { LiveRefresh } from '@/components/realtime/live-refresh';
import { Button } from '@/components/ui/button';
import { SegmentedLinks } from '@/components/ui/segmented';
import { common } from '@/i18n/messages/common';
import { domains as messages } from '@/i18n/messages/domains';
import { getT } from '@/i18n/server';
import { listDomains } from '@/lib/domains';
import { formatSettingsOf } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import { relativeTime } from '@/lib/relative-time';
import { DomainsView } from './domains-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT(messages))('meta.title') };
}

export const dynamic = 'force-dynamic';

/**
 * "Domains": all the instance's names on a single screen, with the proxy that
 * serves them, their state and their certificate's expiry. An application's
 * record shows its own; this page answers the operator's question — "what,
 * somewhere, does not answer or is going to expire?".
 *
 * Nothing changes here: a domain is set on its application's record, where one
 * also sees what it serves. A click on a domain opens its drawer: where the name
 * leads, who it belongs to, which certificate it presents.
 */
export default async function DomainsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePagePermission('/domains', 'application:read');
  const [t, tc, settings, rows] = await Promise.all([
    getT(messages),
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
        <DomainsView
          rows={shown.map((row) => ({
            ...row,
            checked: relativeTime(row.lastCheckedAt, tc) ?? t('checked.never'),
          }))}
          format={format}
        />
      )}
    </>
  );
}
