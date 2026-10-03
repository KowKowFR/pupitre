import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getAppSettingsValue, getPublishedStatusPage } from '@pupitre/db';
import { AutoRefresh } from '@/components/status/auto-refresh';
import { StatusPageView } from '@/components/status/status-page-view';
import { formatSettingsOf } from '@/lib/format';
import { buildStatusPageModel } from '@/lib/status-page';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ slug?: string[] }> };

/** `/status` → page d'adresse vide ; `/status/clients` → « clients » ; plus profond : rien. */
async function pageFor(params: Props['params']) {
  const { slug = [] } = await params;
  if (slug.length > 1) return null;
  return getPublishedStatusPage(slug[0] ?? '');
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = await pageFor(params);
  return {
    title: page?.title ?? null,
    // Partagée par un lien, pas trouvée par un moteur de recherche.
    robots: { index: false, follow: false },
  };
}

/**
 * Une page de statut publique. Sans session : `proxy.ts` laisse passer
 * `/status`, et rien ici ne lit la session. Une page absente **ou non
 * publiée** répond 404, la même réponse, pour ne rien dire de ce qui existe.
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
