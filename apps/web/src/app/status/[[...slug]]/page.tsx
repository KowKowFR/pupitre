import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getAppSettingsValue, getPublishedStatusPage } from '@pupitre/db';
import { AutoRefresh } from '@/components/status/auto-refresh';
import { StatusPageView } from '@/components/status/status-page-view';
import { formatSettingsOf } from '@/lib/format';
import { buildStatusPageModel } from '@/lib/status-page';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ slug?: string[] }> };

/** `/status` → page with an empty address; `/status/clients` → "clients"; deeper: nothing. */
async function pageFor(params: Props['params']) {
  const { slug = [] } = await params;
  if (slug.length > 1) return null;
  return getPublishedStatusPage(slug[0] ?? '');
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = await pageFor(params);
  return {
    title: page?.title ?? null,
    // Shared through a link, not found through a search engine.
    robots: { index: false, follow: false },
  };
}

/**
 * A public status page. Without a session: `proxy.ts` lets `/status` through,
 * and nothing here reads the session. An absent **or unpublished** page answers
 * 404, the same answer, so as to say nothing of what exists.
 */
export default async function PublicStatusPage({ params }: Props) {
  const page = await pageFor(params);
  if (!page) notFound();
  const [model, settings] = await Promise.all([buildStatusPageModel(page), getAppSettingsValue()]);
  return (
    <>
      <AutoRefresh seconds={60} />
      <StatusPageView model={model} format={formatSettingsOf(settings)} />
    </>
  );
}
