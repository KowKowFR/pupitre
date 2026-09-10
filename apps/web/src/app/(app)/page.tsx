import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import {
  deploymentQuerySchema,
  listApplications,
  listDeployments,
  listTargets,
  pingDb,
  type DeploymentSummary,
  type PublicTarget,
} from '@tp/db';
import { Led, Readout, ReadoutBar } from '@/components/instrument';
import { PageHeader } from '@/components/page-header';
import { PingButton } from '@/components/ping-button';
import { Badge, CodeBadge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { currentAuth } from '@/lib/page-auth';
import { getRedis } from '@/lib/redis';
import { DeploymentStatusBadge, formatDuration } from './deployments/status-badge';
import { RuntimeBadges, StatusBadge } from './targets/runtime-badges';

export const dynamic = 'force-dynamic';

async function check(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch {
    return false;
  }
}

/**
 * Poste d'exploitation.
 *
 * L'ordre de lecture est celui d'une prise de poste : d'abord les relevés
 * (est-ce que la machine tourne ?), puis ce qui a bougé récemment, puis le
 * parc, puis ses propres droits. Chaque bloc n'est rendu que si la permission
 * correspondante est accordée — le tableau de bord ne contourne pas le RBAC.
 */
export default async function HomePage() {
  const auth = await currentAuth('/');

  const canReadTargets = auth?.can('target:read') ?? false;
  const canReadDeployments = auth?.can('deployment:read') ?? false;
  const canReadApplications = auth?.can('application:read') ?? false;

  const [db, redis, targets, deployments, applications] = await Promise.all([
    check(() => pingDb()),
    check(async () => getRedis().ping()),
    canReadTargets ? listTargets() : Promise.resolve<PublicTarget[]>([]),
    canReadDeployments
      ? listDeployments(deploymentQuerySchema.parse({ pageSize: '8' }))
      : Promise.resolve(null),
    canReadApplications ? listApplications() : Promise.resolve([]),
  ]);

  const recent: DeploymentSummary[] = deployments?.items ?? [];
  const inFlight = recent.filter(
    (item) => item.status === 'running' || item.status === 'pending',
  ).length;
  const targetsUp = targets.filter((target) => target.status === 'ok').length;

  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        eyebrow="Poste d'exploitation"
        title="Tableau de bord"
        description="Le panel orchestre les déploiements ; il n'est jamais l'application déployée. Cet écran donne l'état de l'instance, ce qui vient de partir et sur quelles machines."
      />

      <ReadoutBar>
        <Readout
          label="PostgreSQL"
          value={db ? 'actif' : 'coupé'}
          tone={db ? 'ok' : 'danger'}
          hint="modèle et journal d'audit"
        />
        <Readout
          label="Redis"
          value={redis ? 'actif' : 'coupé'}
          tone={redis ? 'ok' : 'danger'}
          hint="file BullMQ et flux de logs"
        />
        <Readout
          label="Cibles prêtes"
          value={targetsUp}
          unit={`/ ${targets.length}`}
          tone={targets.length === 0 ? 'idle' : targetsUp === targets.length ? 'ok' : 'warn'}
          hint={canReadTargets ? 'preflight au vert' : 'accès restreint'}
        />
        <Readout
          label="En vol"
          value={inFlight}
          tone={inFlight > 0 ? 'signal' : 'idle'}
          pulse={inFlight > 0}
          hint={`${applications.length} application${applications.length > 1 ? 's' : ''} déclarée${applications.length > 1 ? 's' : ''}`}
        />
      </ReadoutBar>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        {canReadDeployments ? (
          <Card className="gap-0 py-0">
            <CardHeader className="flex-row items-center justify-between gap-4 border-b border-line px-5 py-4">
              <div className="space-y-1">
                <CardTitle>Derniers déploiements</CardTitle>
                <CardDescription>
                  {deployments?.total ?? 0} au total, du plus récent au plus ancien.
                </CardDescription>
              </div>
              <SectionLink href="/deployments">Tout voir</SectionLink>
            </CardHeader>
            <CardContent className="px-0">
              {recent.length === 0 ? (
                <p className="px-5 py-8 text-center text-[0.8125rem] text-ink-muted">
                  Rien n&apos;est encore parti. Déclarez une application, puis déployez-la sur une
                  cible.
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {recent.slice(0, 6).map((item) => (
                    <li key={item.id}>
                      <Link
                        href={`/deployments/${item.id}`}
                        className="flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-surface-2/70"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[0.8125rem] font-medium text-ink">
                            {item.applicationSlug}{' '}
                            <span className="font-mono text-xs font-normal text-ink-faint">
                              v{item.version}
                            </span>
                          </div>
                          <div className="truncate font-mono text-[0.6875rem] text-ink-faint">
                            {item.targetName} · {item.runtime}
                          </div>
                        </div>
                        <span className="shrink-0 font-mono text-[0.6875rem] text-ink-faint tabular-nums">
                          {formatDuration(item.startedAt?.toISOString() ?? null, item.finishedAt?.toISOString() ?? null)}
                        </span>
                        <DeploymentStatusBadge status={item.status} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        ) : null}

        {canReadTargets ? (
          <Card className="gap-0 py-0">
            <CardHeader className="flex-row items-center justify-between gap-4 border-b border-line px-5 py-4">
              <div className="space-y-1">
                <CardTitle>Parc de cibles</CardTitle>
                <CardDescription>Machines joignables en SSH.</CardDescription>
              </div>
              <SectionLink href="/targets">Tout voir</SectionLink>
            </CardHeader>
            <CardContent className="px-0">
              {targets.length === 0 ? (
                <p className="px-5 py-8 text-center text-[0.8125rem] text-ink-muted">
                  Aucune machine déclarée.
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {targets.slice(0, 5).map((target) => (
                    <li key={target.id}>
                      <Link
                        href={`/targets/${target.id}`}
                        className="flex flex-col gap-1.5 px-5 py-3 transition-colors hover:bg-surface-2/70"
                      >
                        <div className="flex items-center gap-2">
                          <Led
                            tone={
                              target.status === 'ok'
                                ? 'ok'
                                : target.status === 'unreachable'
                                  ? 'danger'
                                  : target.status === 'degraded'
                                    ? 'warn'
                                    : 'idle'
                            }
                          />
                          <span className="truncate text-[0.8125rem] font-medium text-ink">
                            {target.name}
                          </span>
                          <span className="ml-auto shrink-0">
                            <StatusBadge status={target.status} />
                          </span>
                        </div>
                        <div className="flex items-center gap-2 pl-4">
                          <CodeBadge>
                            {target.sshUser}@{target.host}
                          </CodeBadge>
                          <RuntimeBadges runtimes={target.runtimesAvailable} />
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        ) : null}
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Vos accès</CardTitle>
            <CardDescription>
              Rôles issus de <code className="font-mono text-xs">user_roles</code>, permissions
              effectives résolues en base à chaque requête.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-1.5">
              {auth?.roles.map((role) => (
                <Badge key={role} variant="default">
                  {role}
                </Badge>
              ))}
            </div>
            <div className="flex flex-wrap gap-1">
              {auth?.permissions.toSorted().map((permission) => (
                <CodeBadge key={permission}>{permission}</CodeBadge>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Chaîne asynchrone</CardTitle>
            <CardDescription>
              Route HTTP → BullMQ (<code className="font-mono text-xs">ops</code>) → worker →{' '}
              <code className="font-mono text-xs">audit_logs</code>. Requiert{' '}
              <code className="font-mono text-xs">job:manage</code>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PingButton />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SectionLink({ href, children }: { href: string; children: string }) {
  return (
    <Link
      href={href}
      className="flex shrink-0 items-center gap-1 text-xs text-ink-muted transition-colors hover:text-signal"
    >
      {children}
      <ArrowUpRight className="size-3.5" />
    </Link>
  );
}
