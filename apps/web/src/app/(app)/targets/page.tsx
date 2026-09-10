import Link from 'next/link';
import { getAppSettings, listTargets } from '@tp/db';
import { Plus } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { TargetHelpDialog } from '@/components/target-help';
import { Button } from '@/components/ui/button';
import { formatSettingsOf } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import { TargetsTable } from './targets-table';

export const dynamic = 'force-dynamic';

export default async function TargetsPage() {
  const auth = await requirePagePermission('/targets', 'target:read');
  const [targets, { settings }] = await Promise.all([listTargets(), getAppSettings()]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Parc"
        title="Machines cibles"
        description="Les machines sur lesquelles le panel déploie, joignables en SSH. Le preflight détermine ce qui y est exécutable — Docker, K3s, ou ni l'un ni l'autre."
        actions={
          auth.can('target:create') ? (
            <Button asChild size="sm">
              <Link href="/targets/new">
                <Plus />
                Ajouter une cible
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
      />
    </div>
  );
}
