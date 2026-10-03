'use client';

import Link from 'next/link';
import { Lock, Pencil, RefreshCw, Server } from 'lucide-react';
import { RecordDrawer, RecordSkeleton, type RecordTab } from '@/components/record-drawer';
import { MicroSpark } from '@/components/spark';
import { TargetLabelList } from '@/components/target-label';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KeyValue } from '@/components/ui/data';
import { DrawerDanger, DrawerFooter, DrawerHeader, DrawerSection } from '@/components/ui/drawer';
import { Led, State, type Tone } from '@/components/ui/led';
import { useT } from '@/i18n/client';
import { chrome } from '@/i18n/messages/chrome';
import { common } from '@/i18n/messages/common';
import { targets as messages } from '@/i18n/messages/targets';
import type { TargetRecord, TargetRecordTab } from './record/record';
import { STATUS_TONE } from './status';
import { TargetForm, type CreatedTarget } from './target-form';
import { Runtimes, type Limits, type TargetRow } from './targets-view';

const HEALTH_TONE: Record<string, Tone> = {
  healthy: 'ok',
  unhealthy: 'warn',
  unreachable: 'danger',
  unknown: 'idle',
};

/** La part de la fiche que rend le serveur, telle qu'elle traverse jusqu'ici. */
export type TargetRecordView = Pick<TargetRecord, 'key' | 'overview' | 'tabs' | 'counts'>;

const SERVER_TABS: TargetRecordTab[] = ['workloads', 'proxy', 'ports', 'preflight', 'config'];

/**
 * La fiche d'une cible, dans un tiroir. L'aperçu se lit sur la ligne de la
 * liste — son état et ce qui l'explique, sa connexion, ses runtimes, sa
 * charge, ce qu'elle porte — et s'ouvre sur les relevés de la machine ; les
 * autres onglets arrivent du serveur. « Modifier » remplace la fiche par le
 * formulaire, dans le même tiroir. La suppression, en bas de l'aperçu, n'est
 * active que lorsque l'API l'accepterait.
 */
export function TargetDrawer({
  target,
  record,
  editing,
  onEdit,
  onEdited,
  onClose,
  onPrevious,
  onNext,
  limits,
  canRunPreflight,
  canEdit,
  canDelete,
  canReadWorkloads,
  testing,
  onTest,
  onDelete,
}: {
  target: TargetRow | null;
  /** La fiche rendue au serveur, si c'est bien celle de `target`. */
  record: TargetRecordView | null;
  editing: boolean;
  onEdit: (editing: boolean) => void;
  onEdited: (target: CreatedTarget) => void;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  limits: Limits;
  canRunPreflight: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canReadWorkloads: boolean;
  testing: boolean;
  onTest: () => void;
  onDelete: () => void;
}) {
  const t = useT(messages);
  const tChrome = useT(chrome);
  const tc = useT(common);
  const ready = record !== null && target !== null && record.key === target.name;

  const overview = target ? (
    <>
      {ready ? record.overview : <RecordSkeleton />}

      {target.status === 'unreachable' ? (
        <Alert variant="destructive" title={t('drawer.alert.unreachable.title')}>
          {t('drawer.alert.unreachable', { time: target.lastCheckClock ?? '—' })}
          {target.error ? (
            <span className="mono mt-1 block text-[12px]">{target.error}</span>
          ) : null}
        </Alert>
      ) : target.status === 'degraded' ? (
        <Alert variant="warn" title={t('drawer.alert.degraded.title')}>
          {t('drawer.alert.degraded', { checks: target.failedChecks.join(', ') || '—' })}
        </Alert>
      ) : target.status === 'unknown' ? (
        <Alert variant="info" title={t('drawer.alert.unknown.title')}>
          {t('drawer.alert.unknown')}
        </Alert>
      ) : null}

      <DrawerSection title={t('card.connection')}>
        <KeyValue
          items={[
            {
              term: t('drawer.address'),
              value: (
                <span className="mono">
                  {target.sshUser}@{target.host}:{target.port}
                </span>
              ),
            },
            {
              term: t('field.authMethod'),
              value: target.authMethod === 'key' ? t('value.auth.key') : t('value.auth.password'),
            },
            {
              term: t('drawer.sudo'),
              value: target.sudoMethod === 'nopasswd' ? t('sudo.nopasswd') : t('sudo.password'),
            },
            {
              term: t('field.credential'),
              value: (
                <span className="inline-flex items-center gap-1.5">
                  <Lock aria-hidden className="!size-3.5 text-text-3" />
                  {t('value.credential')}
                </span>
              ),
            },
            {
              term: t('field.portRangeShort'),
              value: (
                <>
                  <span className="mono">
                    {target.portRange.start}-{target.portRange.end}
                  </span>
                  {target.portsUsed !== null ? (
                    <span className="text-text-3">
                      {' '}
                      · {t('drawer.ports.used', { count: target.portsUsed })}
                    </span>
                  ) : null}
                </>
              ),
            },
          ]}
        />
      </DrawerSection>

      <DrawerSection title={t('column.runtimes')}>
        <Runtimes runtimes={target.runtimesAvailable} />
      </DrawerSection>

      {target.measured ? (
        <DrawerSection
          title={t('drawer.load')}
          aside={
            <span className="t-cap font-normal text-text-3">
              {t('drawer.load.aside', {
                worst: Math.round(target.loadWorst ?? 0),
                limit: limits.load,
              })}
            </span>
          }
        >
          <div className="well flex flex-col gap-2">
            <MicroSpark
              values={target.load}
              width={940}
              height={56}
              max={100}
              tone="var(--accent)"
              dot
              className="h-14 w-full"
            />
            <div className="axis">
              <span>{tChrome('chart.axis.hoursAgo', { hours: 24 })}</span>
              <span>{tChrome('chart.axis.hoursAgo', { hours: 12 })}</span>
              <span>{tChrome('chart.axis.now')}</span>
            </div>
          </div>
        </DrawerSection>
      ) : null}

      {target.apps !== null ? (
        <DrawerSection
          title={t('drawer.apps')}
          aside={
            target.apps.length > 0 ? <Badge variant="count">{target.apps.length}</Badge> : undefined
          }
        >
          {target.apps.length === 0 ? (
            <p className="t-sm text-text-3">{t('drawer.apps.none')}</p>
          ) : (
            <div className="card card-flat overflow-hidden">
              <ul className="list is-link">
                {target.apps.map((app) => (
                  <li key={app.id} className="relative">
                    <Led tone={HEALTH_TONE[app.health] ?? 'idle'} />
                    <Link
                      href={`/apps/${app.id}`}
                      className="mono text-[12.5px] text-text after:absolute after:inset-0"
                    >
                      {app.slug}
                    </Link>
                    <span className="t-cap ml-auto text-text-3">
                      {t(`app.health.${app.health as 'healthy'}`)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </DrawerSection>
      ) : null}

      {canDelete ? <DeleteZone target={target} onDelete={onDelete} /> : null}
    </>
  ) : null;

  const tabs: RecordTab[] = [
    { key: 'overview', label: t('detail.tab.overview'), content: overview },
    ...SERVER_TABS.filter((key) => key !== 'workloads' || canReadWorkloads).map((key) => ({
      key,
      label: t(`detail.tab.${key}`),
      count: ready ? record.counts[key] : undefined,
      content: ready ? (record.tabs[key] ?? null) : undefined,
    })),
  ];

  return (
    <RecordDrawer
      open={target !== null}
      recordKey={target?.name ?? null}
      onClose={onClose}
      onPrevious={onPrevious}
      onNext={onNext}
      label={target?.name}
      tabsLabel={t('detail.tabs')}
      tabs={tabs}
      header={
        target ? (
          <DrawerHeader
            icon={<Server className="!size-3.5" />}
            kind={t('drawer.kind')}
            route={target.description ?? undefined}
            title={target.name}
            state={
              <>
                <State
                  tone={STATUS_TONE[target.status]}
                  meta={
                    target.status === 'unknown'
                      ? t('drawer.never')
                      : target.testedAgo
                        ? t('drawer.tested', { ago: target.testedAgo })
                        : undefined
                  }
                >
                  {t(`status.${target.status}`)}
                </State>
                <TargetLabelList labels={target.labels} className="ml-auto" />
              </>
            }
          />
        ) : null
      }
      footer={() => (
        <DrawerFooter end={null}>
          {canRunPreflight ? (
            <Button loading={testing} onClick={onTest}>
              {testing ? null : <RefreshCw aria-hidden />}
              {testing ? t('action.testing') : t('action.test')}
            </Button>
          ) : null}
          {canEdit ? (
            <Button variant="secondary" onClick={() => onEdit(true)}>
              <Pencil aria-hidden />
              {tc('edit')}
            </Button>
          ) : null}
        </DrawerFooter>
      )}
      override={
        target && editing && canEdit ? (
          <>
            <DrawerHeader
              icon={<Pencil className="!size-3.5" />}
              kind={t('drawer.kind')}
              title={t('edit.title', { name: target.name })}
              extra={
                <div className="flex flex-col gap-1">
                  <p className="t-sm text-text-2">{t('edit.description')}</p>
                  <p className="t-cap text-text-3">{t('edit.card.description')}</p>
                </div>
              }
            />
            {/* La ligne ne porte pas la colonne chiffrée : le formulaire ne
                reçoit jamais de credential, il ne peut que le remplacer. */}
            <TargetForm
              frame="drawer"
              initial={{
                id: target.id,
                name: target.name,
                description: target.description,
                host: target.host,
                port: target.port,
                sshUser: target.sshUser,
                authMethod: target.authMethod,
                sudoMethod: target.sudoMethod,
                portRangeStart: target.portRange.start,
                portRangeEnd: target.portRange.end,
                labels: target.labels,
              }}
              onCreated={onEdited}
              onCancel={() => onEdit(false)}
            />
          </>
        ) : undefined
      }
    />
  );
}

function DeleteZone({ target, onDelete }: { target: TargetRow; onDelete: () => void }) {
  const t = useT(messages);
  const tc = useT(common);
  const blockedReason = !target.deployments
    ? null
    : target.deployments.live > 0
      ? t('error.liveDeployments', { count: target.deployments.live })
      : target.deployments.history > 0
        ? t('error.pastDeployments', { count: target.deployments.history })
        : null;
  return (
    <DrawerDanger>
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="t-sm font-semibold">{t('drawer.delete.title')}</span>
          <span id={`delete-why-${target.id}`} className="t-cap text-text-3">
            {blockedReason ?? t('drawer.delete.free')}
          </span>
        </div>
        <Button
          variant="destructive"
          size="sm"
          disabled={blockedReason !== null}
          aria-describedby={`delete-why-${target.id}`}
          onClick={onDelete}
        >
          {tc('delete')}
        </Button>
      </div>
    </DrawerDanger>
  );
}
