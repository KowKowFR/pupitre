import Link from 'next/link';
import { getAppSettings, listTargets } from '@pupitre/db';
import { Plus } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { TargetHelpDialog } from '@/components/target-help';
import { Button } from '@/components/ui/button';
import { getT } from '@/i18n/server';
import { targets as messages } from '@/i18n/messages/targets';
import { formatSettingsOf } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import { TargetsTable } from './targets-table';

export const dynamic = 'force-dynamic';

/**
 * Les filtres sont lus ici, côté serveur, et non par `useSearchParams` dans la
 * table : le premier rendu doit déjà être filtré. Une fiche de cible pointe
 * vers `/targets?label=env%3Dprod` ; sans cette lecture, ce lien afficherait
 * tout le parc l'espace d'une frame avant de le réduire.
 */
function readFilters(params: Record<string, string | string[] | undefined>) {
  const raw = params.label;
  return {
    query: typeof params.q === 'string' ? params.q : '',
    labels: (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((pair) => pair.includes('=')),
  };
}

export default async function TargetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await requirePagePermission('/targets', 'target:read');
  const [targets, { settings }, params, t] = await Promise.all([
    listTargets(),
    getAppSettings(),
    searchParams,
    getT(messages),
  ]);
  const filters = readFilters(params);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('page.title')}
        description={t('page.description')}
        actions={
          auth.can('target:create') ? (
            <Button asChild size="sm">
              <Link href="/targets/new">
                <Plus />
                {t('page.add')}
              </Link>
            </Button>
          ) : null
        }
      />

      {/* Même place que l'aide AppSpec sur /applications : sous le bandeau, au
          contact de la table dont elle explique le vocabulaire — et visible
          aussi quand la table est vide, cas de celui qui découvre le panel. */}
      <TargetHelpDialog />

      <TargetsTable
        targets={targets.map((target) => ({
          ...target,
          lastPreflightAt: target.lastPreflightAt?.toISOString() ?? null,
          createdAt: target.createdAt.toISOString(),
          updatedAt: target.updatedAt.toISOString(),
        }))}
        canRunPreflight={auth.can('target:update')}
        canDelete={auth.can('target:delete')}
        format={formatSettingsOf(settings)}
        initialQuery={filters.query}
        initialLabels={filters.labels}
      />
    </div>
  );
}
