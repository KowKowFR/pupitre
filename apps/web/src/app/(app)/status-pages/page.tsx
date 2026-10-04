import type { Metadata } from 'next';
import { getAppSettingsValue, listMonitors, listStatusPages } from '@pupitre/db';
import { PageHeader } from '@/components/page-header';
import { LiveRefresh } from '@/components/realtime/live-refresh';
import { statusPages as messages } from '@/i18n/messages/status-pages';
import { getT } from '@/i18n/server';
import { formatSettingsOf } from '@/lib/format';
import { requirePageAnyPermission } from '@/lib/page-auth';
import { statusPageJson } from '@/lib/status-page';
import { loadAnnounceSubjects } from '@/lib/status-updates';
import { Announcements } from './announcements';
import { NewStatusPageButton, StatusPagesView } from './status-pages-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT(messages))('meta.title') };
}

export const dynamic = 'force-dynamic';

/**
 * "Status pages": the public pages the administrator composes — the list here,
 * the editor in a drawer (`?page=<id>`, `?page=nouvelle`) — and the announcements
 * published there during an outage or a maintenance window
 * (`?annonce=incident:<id>`). Each one sees the part their role opens to them.
 */
export default async function StatusPagesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await requirePageAnyPermission('/status-pages', [
    'status_page:manage',
    'status_page:announce',
  ]);
  const canManage = auth.can('status_page:manage');
  const canAnnounce = auth.can('status_page:announce');
  const params = await searchParams;
  const asked = typeof params.annonce === 'string' ? params.annonce : null;
  const [t, settings, pages, monitors] = await Promise.all([
    getT(messages),
    getAppSettingsValue(),
    listStatusPages(),
    canManage ? listMonitors() : Promise.resolve([]),
  ]);
  const subjects = canAnnounce ? await loadAnnounceSubjects(pages, asked) : [];
  const format = formatSettingsOf(settings);
  return (
    <>
      <LiveRefresh topics={['settings', 'monitors', 'targets']} />
      <PageHeader
        title={t('page.title')}
        description={t('page.description')}
        actions={canManage ? <NewStatusPageButton /> : undefined}
      />
      <div className="flex flex-col gap-6">
        {canAnnounce ? <Announcements subjects={subjects} format={format} /> : null}
        {canManage ? (
          <StatusPagesView
            pages={pages.map(statusPageJson)}
            monitors={monitors.map((monitor) => ({ id: monitor.id, name: monitor.name }))}
            format={format}
          />
        ) : null}
      </div>
    </>
  );
}
