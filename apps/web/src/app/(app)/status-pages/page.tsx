import type { Metadata } from 'next';
import { getAppSettingsValue, listMonitors, listStatusPages } from '@pupitre/db';
import { PageHeader } from '@/components/page-header';
import { LiveRefresh } from '@/components/realtime/live-refresh';
import { statusPages as messages } from '@/i18n/messages/status-pages';
import { getT } from '@/i18n/server';
import { formatSettingsOf } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import { statusPageJson } from '@/lib/status-page';
import { NewStatusPageButton, StatusPagesView } from './status-pages-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT(messages))('meta.title') };
}

export const dynamic = 'force-dynamic';

/**
 * « Pages de statut » : les pages publiques que l'administrateur compose. La
 * liste ici, l'éditeur dans un tiroir (`?page=<id>`, `?page=nouvelle`), avec
 * un aperçu calculé comme la page publique.
 */
export default async function StatusPagesPage() {
  await requirePagePermission('/status-pages', 'status_page:manage');
  const [t, settings, pages, monitors] = await Promise.all([
    getT(messages),
    getAppSettingsValue(),
    listStatusPages(),
    listMonitors(),
  ]);
  return (
    <>
      <LiveRefresh topics={['settings']} />
      <PageHeader
        title={t('page.title')}
        description={t('page.description')}
        actions={<NewStatusPageButton />}
      />
      <StatusPagesView
        pages={pages.map(statusPageJson)}
        monitors={monitors.map((monitor) => ({ id: monitor.id, name: monitor.name }))}
        format={formatSettingsOf(settings)}
      />
    </>
  );
}
