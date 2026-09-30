'use client';

import Link from 'next/link';
import { Lock, RefreshCw, Server } from 'lucide-react';
import { TargetLabelList } from '@/components/target-label';
import { MicroSpark } from '@/components/spark';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KeyValue, MiniGauge } from '@/components/ui/data';
import {
  Drawer,
  DrawerBody,
  DrawerDanger,
  DrawerFooter,
  DrawerHeader,
  DrawerSection,
} from '@/components/ui/drawer';
import { Led, State, type Tone } from '@/components/ui/led';
import { useT } from '@/i18n/client';
import { chrome } from '@/i18n/messages/chrome';
import { common } from '@/i18n/messages/common';
import { targets as messages } from '@/i18n/messages/targets';
import { STATUS_TONE } from './status';
import { Runtimes, type Limits, type TargetRow } from './targets-view';

const HEALTH_TONE: Record<string, Tone> = {
  healthy: 'ok',
  unhealthy: 'warn',
  unreachable: 'danger',
  unknown: 'idle',
};

/**
 * L'aperçu d'une cible : son état et ce qui l'explique, sa connexion, ses
 * runtimes, sa charge, ce qu'elle porte — et, en bas, la suppression, qui
 * n'est active que lorsque l'API l'accepterait.
 */
export function TargetDrawer({
  target,
  open,
  onOpenChange,
  onPrevious,
  onNext,
  limits,
  canRunPreflight,
  canEdit,
  canDelete,
  testing,
  onTest,
  onDelete,
}: {
  target: TargetRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPrevious?: () => void;
  onNext?: () => void;
  limits: Limits;
  canRunPreflight: boolean;
  canEdit: boolean;
  canDelete: boolean;
  testing: boolean;
  onTest: () => void;
  onDelete: () => void;
}) {
  const t = useT(messages);
  const tChrome = useT(chrome);
  const tc = useT(common);
  if (!target)
    return (
      <Drawer open={false} onOpenChange={onOpenChange}>
        {null}
      </Drawer>
    );

  const tone = STATUS_TONE[target.status];
  const meta =
    target.status === 'unknown'
      ? t('drawer.never')
      : target.testedAgo
        ? t('drawer.tested', { ago: target.testedAgo })
        : undefined;
  const blockedReason = !target.deployments
    ? null
    : target.deployments.live > 0
      ? t('error.liveDeployments', { count: target.deployments.live })
      : target.deployments.history > 0
        ? t('error.pastDeployments', { count: target.deployments.history })
        : null;

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      onPrevious={onPrevious}
      onNext={onNext}
      recordHref={`/targets/${target.id}`}
    >
      <DrawerHeader
        icon={<Server className="!size-3.5" />}
        kind={t('drawer.kind')}
        route={`/targets/${target.name}`}
        title={target.name}
        state={
          <>
            <State tone={tone} meta={meta}>
              {t(`status.${target.status}`)}
            </State>
            <TargetLabelList labels={target.labels} className="ml-auto" />
          </>
        }
      />

      <DrawerBody>
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
                width={470}
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
            <div className="flex flex-wrap gap-4">
              {target.loadLast !== null ? (
                <MiniGauge
                  label={t('gauge.load')}
                  percent={target.loadLast}
                  tone={target.loadLast >= limits.load ? 'warn' : undefined}
                />
              ) : null}
              {target.memory !== null ? (
                <MiniGauge
                  label={t('gauge.memory')}
                  percent={target.memory}
                  tone={target.memory >= limits.memory ? 'warn' : undefined}
                />
              ) : null}
              {target.disk !== null ? (
                <MiniGauge
                  label={t('gauge.disk')}
                  percent={target.disk}
                  tone={target.disk >= limits.disk ? 'warn' : undefined}
                />
              ) : null}
            </div>
          </DrawerSection>
        ) : null}

        {target.apps !== null ? (
          <DrawerSection
            title={t('drawer.apps')}
            aside={
              target.apps.length > 0 ? (
                <Badge variant="count">{target.apps.length}</Badge>
              ) : undefined
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

        {canDelete ? (
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
        ) : null}
      </DrawerBody>

      <DrawerFooter>
        {canRunPreflight ? (
          <Button loading={testing} onClick={onTest}>
            {testing ? null : <RefreshCw aria-hidden />}
            {testing ? t('action.testing') : t('action.test')}
          </Button>
        ) : null}
        {canEdit ? (
          <Button variant="secondary" asChild>
            <Link href={`/targets/${target.id}/edit`}>{tc('edit')}</Link>
          </Button>
        ) : null}
      </DrawerFooter>
    </Drawer>
  );
}
