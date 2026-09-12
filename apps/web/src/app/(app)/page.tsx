import Link from 'next/link';
import {
  deploymentQuerySchema,
  listApplications,
  listDeployments,
  listMonitors,
  listSupervisedApps,
  listTargets,
  type DeploymentSummary,
  type PublicTarget,
} from '@tp/db';
import { Led, Readout, ReadoutBar, type Tone } from '@/components/instrument';
import { PageHeader } from '@/components/page-header';
import { currentAuth } from '@/lib/page-auth';
import { AttentionPanel, Panel, PanelEmpty, type AttentionItem } from './attention';
import { DeploymentStatusBadge } from './deployments/status-badge';

export const dynamic = 'force-dynamic';

/**
 * Poste d'exploitation.
 *
 * L'ordre de lecture est une prise de position : **les anomalies d'abord,
 * l'inventaire en dernier**. Un opérateur ouvre cet écran pour savoir s'il doit
 * intervenir, pas pour compter ses machines. Les relevés chiffrés gardent leur
 * place — en bas, où l'on va quand rien ne presse.
 *
 * Chaque bloc n'est rendu que si la permission correspondante est accordée : le
 * tableau de bord ne contourne pas le RBAC, et une anomalie qu'on n'a pas le
 * droit de voir n'apparaît pas dans le décompte.
 */

const HEALTH_TONE: Record<string, Tone> = {
  healthy: 'ok',
  unhealthy: 'warn',
  unreachable: 'danger',
  unknown: 'idle',
};

const HEALTH_LABEL: Record<string, string> = {
  healthy: 'en marche',
  unhealthy: 'répond mal',
  unreachable: 'injoignable',
  unknown: 'état inconnu',
};

/** « il y a 3 min ». Rend `null` plutôt qu'un tiret : l'appelant décide. */
function since(date: Date | null): string | null {
  if (!date) return null;
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `il y a ${seconds} s`;
  if (seconds < 3600) return `il y a ${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `il y a ${Math.floor(seconds / 3600)} h`;
  return `il y a ${Math.floor(seconds / 86_400)} j`;
}

export default async function HomePage() {
  const auth = await currentAuth('/');

  const canReadTargets = auth?.can('target:read') ?? false;
  const canReadDeployments = auth?.can('deployment:read') ?? false;
  const canReadApplications = auth?.can('application:read') ?? false;
  const canReadMonitors = auth?.can('monitor:read') ?? false;

  const [targets, deployments, applications, running, monitors] = await Promise.all([
    canReadTargets ? listTargets() : Promise.resolve<PublicTarget[]>([]),
    canReadDeployments
      ? listDeployments(deploymentQuerySchema.parse({ pageSize: '6' }))
      : Promise.resolve(null),
    canReadApplications ? listApplications() : Promise.resolve([]),
    canReadDeployments ? listSupervisedApps() : Promise.resolve([]),
    canReadMonitors ? listMonitors() : Promise.resolve([]),
  ]);

  const recent: DeploymentSummary[] = deployments?.items ?? [];
  const inFlight = recent.filter(
    (item) => item.status === 'running' || item.status === 'pending',
  ).length;
  const targetsUp = targets.filter((target) => target.status === 'ok').length;
  // Une cible jamais testée n'est pas une cible en panne : c'est une
  // installation qu'on n'a pas finie. Les confondre faisait dire deux choses
  // contraires au même écran — « rien ne demande d'intervention » en tête, et
  // un relevé orange en bas pour des machines dont on ignore simplement l'état.
  const targetsUntested = targets.filter((target) => target.status === 'unknown').length;
  const targetsDown = targets.length - targetsUp - targetsUntested;
  const monitorsUp = monitors.filter((monitor) => monitor.status === 'healthy').length;
  const appsHealthy = running.filter((app) => app.healthStatus === 'healthy').length;

  const attention = collectAttention({ targets, running, monitors, recent });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Poste d'exploitation"
        title="Tableau de bord"
        description="Ce qui demande une intervention, puis ce qui tourne et ce qui vient de partir."
      />

      <AttentionPanel items={attention} />

      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <Panel
          title="En marche"
          href={canReadDeployments ? '/apps' : undefined}
          linkLabel="Supervision"
          hint={canReadDeployments ? undefined : 'accès restreint'}
        >
          {running.length === 0 ? (
            <PanelEmpty>
              Aucune application en marche. Déployez-en une depuis{' '}
              <Link href="/applications" className="text-signal underline underline-offset-4">
                Applications
              </Link>
              .
            </PanelEmpty>
          ) : (
            <ul className="divide-line divide-y">
              {running.slice(0, 6).map((app) => (
                <li
                  key={app.id}
                  className="flex items-center gap-3 px-5 py-2.5 text-[0.8125rem]"
                >
                  <Led tone={HEALTH_TONE[app.healthStatus] ?? 'idle'} />
                  <Link
                    href={`/apps/${app.id}`}
                    className="text-ink min-w-0 flex-1 truncate font-mono underline-offset-4 hover:underline"
                  >
                    {app.applicationSlug}
                    <span className="text-ink-faint">@{app.targetName}</span>
                  </Link>
                  <span className="text-ink-muted shrink-0">
                    {HEALTH_LABEL[app.healthStatus] ?? app.healthStatus}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Derniers déploiements"
          href={canReadDeployments ? '/deployments' : undefined}
          linkLabel="Historique"
          hint={canReadDeployments ? undefined : 'accès restreint'}
        >
          {recent.length === 0 ? (
            <PanelEmpty>Aucun déploiement pour l&apos;instant.</PanelEmpty>
          ) : (
            <ul className="divide-line divide-y">
              {recent.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center gap-3 px-5 py-2.5 text-[0.8125rem]"
                >
                  <Link
                    href={`/deployments/${item.id}`}
                    className="text-ink min-w-0 flex-1 truncate font-mono underline-offset-4 hover:underline"
                  >
                    {item.applicationSlug}
                    <span className="text-ink-faint"> v{item.version}</span>
                  </Link>
                  <DeploymentStatusBadge status={item.status} />
                  <span className="text-ink-faint w-20 shrink-0 text-right text-xs tabular-nums">
                    {since(item.finishedAt ?? item.createdAt) ?? ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {/*
        L'inventaire ferme l'écran au lieu de l'ouvrir : ces chiffres rassurent,
        ils ne déclenchent rien. Les mettre en tête repousserait plus bas la
        seule information pour laquelle on ouvre un tableau de bord.
      */}
      <ReadoutBar>
        <Readout
          label="Cibles prêtes"
          value={targetsUp}
          unit={`/ ${targets.length}`}
          tone={
            !canReadTargets || targets.length === 0
              ? 'idle'
              : targetsDown > 0
                ? 'warn'
                : targetsUntested > 0
                  ? 'idle'
                  : 'ok'
          }
          hint={targetsHint({ canReadTargets, targetsDown, targetsUntested })}
        />
        <Readout
          label="Applications en marche"
          value={appsHealthy}
          unit={`/ ${running.length}`}
          tone={running.length === 0 ? 'idle' : appsHealthy === running.length ? 'ok' : 'warn'}
          hint={`${applications.length} déclarée${applications.length > 1 ? 's' : ''}`}
        />
        <Readout
          label="Sondes au vert"
          value={monitorsUp}
          unit={`/ ${monitors.length}`}
          tone={monitors.length === 0 ? 'idle' : monitorsUp === monitors.length ? 'ok' : 'warn'}
          hint={canReadMonitors ? 'supervision de sites' : 'accès restreint'}
        />
        <Readout
          label="En vol"
          value={inFlight}
          tone={inFlight > 0 ? 'signal' : 'idle'}
          pulse={inFlight > 0}
          hint={inFlight > 0 ? 'déploiement en cours' : 'aucun déploiement en cours'}
        />
      </ReadoutBar>
    </div>
  );
}

/**
 * La ligne sous le compteur de cibles — elle doit expliquer l'écart, pas le
 * commenter. « preflight au vert » ne disait rien quand le compte était
 * incomplet, ce qui est précisément le moment où on lit cette ligne.
 */
function targetsHint({
  canReadTargets,
  targetsDown,
  targetsUntested,
}: {
  canReadTargets: boolean;
  targetsDown: number;
  targetsUntested: number;
}): string {
  if (!canReadTargets) return 'accès restreint';

  const parts: string[] = [];
  if (targetsDown > 0) parts.push(`${targetsDown} en défaut`);
  if (targetsUntested > 0) {
    parts.push(`${targetsUntested} jamais testée${targetsUntested > 1 ? 's' : ''}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'preflight au vert';
}

/**
 * Rassemble les anomalies des quatre sources qui peuvent en produire.
 *
 * Une même panne ne doit apparaître qu'une fois : une cible injoignable rend
 * ses applications injoignables, et lister les deux ferait croire à deux
 * incidents. Les cibles muettes sont donc relevées d'abord, et leurs
 * applications écartées ensuite.
 */
function collectAttention({
  targets,
  running,
  monitors,
  recent,
}: {
  targets: PublicTarget[];
  running: Awaited<ReturnType<typeof listSupervisedApps>>;
  monitors: Awaited<ReturnType<typeof listMonitors>>;
  recent: DeploymentSummary[];
}): AttentionItem[] {
  const items: AttentionItem[] = [];

  const mute = new Set<string>();
  for (const target of targets) {
    if (target.status === 'ok' || target.status === 'unknown') continue;
    mute.add(target.name);
    items.push({
      subject: target.name,
      detail:
        target.status === 'unreachable'
          ? `Machine injoignable — ${target.host}. Les applications qu'elle porte ne peuvent plus être ni supervisées, ni mises à jour.`
          : `Preflight dégradé sur ${target.host}. Un déploiement peut échouer sans que la cause soit visible.`,
      severity: target.status === 'unreachable' ? 'danger' : 'warn',
      href: `/targets/${target.id}`,
      action: 'Diagnostiquer',
    });
  }

  for (const app of running) {
    if (mute.has(app.targetName)) continue;

    if (app.healthStatus === 'unreachable' || app.healthStatus === 'unhealthy') {
      items.push({
        subject: `${app.applicationSlug}@${app.targetName}`,
        detail:
          app.healthStatus === 'unreachable'
            ? "L'application ne répond plus à sa sonde de santé."
            : 'La sonde de santé répond, mais pas comme attendu.',
        severity: app.healthStatus === 'unreachable' ? 'danger' : 'warn',
        href: `/apps/${app.id}`,
        action: 'Voir les logs',
      });
      continue;
    }

    if (app.lastFailedUpdate) {
      items.push({
        subject: `${app.applicationSlug}@${app.targetName}`,
        detail:
          `La mise à jour en v${app.lastFailedUpdate.version} a échoué à l'étape ` +
          `« ${app.lastFailedUpdate.failedStep ?? 'inconnue'} ». ` +
          (app.lastFailedUpdate.mayHaveReplacedServices
            ? 'Elle avait commencé à remplacer les conteneurs : vérifiez ce qui tourne.'
            : 'La version précédente tourne toujours.'),
        severity: 'warn',
        href: `/deployments/${app.lastFailedUpdate.deploymentId}`,
        action: 'Voir la trace',
      });
    }
  }

  for (const monitor of monitors) {
    if (!monitor.enabled) continue;
    if (monitor.status !== 'unreachable' && monitor.status !== 'unhealthy') continue;
    items.push({
      subject: monitor.name,
      detail:
        monitor.status === 'unreachable'
          ? 'La sonde ne joint plus sa cible depuis le panel.'
          : 'La sonde joint sa cible, mais la réponse ne correspond pas à ce qui est attendu.',
      severity: monitor.status === 'unreachable' ? 'danger' : 'warn',
      href: `/monitors/${monitor.id}`,
      action: 'Voir la sonde',
    });
  }

  // Un déploiement raté d'une application qui tourne encore est déjà relevé
  // ci-dessus, avec plus de contexte. On ne garde ici que les échecs orphelins.
  const covered = new Set(running.map((app) => app.lastFailedUpdate?.deploymentId).filter(Boolean));
  for (const item of recent) {
    if (item.status !== 'failed' || covered.has(item.id)) continue;
    items.push({
      subject: `${item.applicationSlug} v${item.version}`,
      detail: `Déploiement échoué sur ${item.targetName}${item.failedStep ? ` à l'étape « ${item.failedStep} »` : ''}.`,
      severity: 'danger',
      href: `/deployments/${item.id}`,
      action: 'Voir la trace',
    });
  }

  return items;
}
