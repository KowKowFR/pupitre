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
 * « Domaines » : tous les noms de l'instance sur un seul écran, avec le proxy
 * qui les sert, leur état et l'échéance de leur certificat. La fiche d'une
 * application en montre les siens ; cette page répond à la question de
 * l'exploitant — « qu'est-ce qui, quelque part, ne répond pas ou va expirer ? ».
 *
 * Rien ne s'y modifie : un domaine se règle sur la fiche de son application,
 * là où l'on voit aussi ce qu'il sert. Un clic sur un domaine ouvre son
 * tiroir : où mène le nom, à qui il appartient, quel certificat il présente.
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
