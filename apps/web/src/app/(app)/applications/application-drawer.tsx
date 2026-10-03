'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Boxes, Rocket } from 'lucide-react';
import { RecordDrawer, type RecordTab } from '@/components/record-drawer';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CheckboxField } from '@/components/ui/checkbox';
import { DrawerFooter, DrawerHeader, DrawerSection } from '@/components/ui/drawer';
import { Field } from '@/components/ui/field';
import { Led, type Tone } from '@/components/ui/led';
import { Select } from '@/components/ui/select';
import { useT } from '@/i18n/client';
import { applications as messages } from '@/i18n/messages/applications';
import { ServiceChips, type ApplicationRow, type DeployTarget } from './applications-view';
import type { ApplicationRecord, ApplicationRecordTab } from './record/record';
import { ServiceList } from './service-list';

const HEALTH_TONE: Record<string, Tone> = {
  healthy: 'ok',
  unhealthy: 'warn',
  unreachable: 'danger',
  unknown: 'idle',
};

/** La part de la fiche que rend le serveur, telle qu'elle traverse jusqu'ici. */
export type ApplicationRecordView = Pick<ApplicationRecord, 'key' | 'tabs' | 'counts' | 'alerts'>;

const SERVER_TABS: ApplicationRecordTab[] = [
  'versions',
  'code',
  'domains',
  'secrets',
  'backups',
  'images',
  'security',
];

/**
 * La fiche d'une application, dans un tiroir. L'onglet « Aperçu » se lit sur
 * la ligne de la liste — ce qui va tourner, où elle est en service — et porte
 * le déploiement rapide ; les autres onglets arrivent du serveur. Le choix de
 * la cible borne celui du runtime : on ne propose que ce que le preflight a vu.
 */
export function ApplicationDrawer({
  application,
  record,
  onClose,
  onPrevious,
  onNext,
  targets,
  canDeploy,
  canDelete,
  canReadBackups,
  canReadScans = false,
  autoRollback,
  onAutoRollbackChange,
  backupChoice,
  domainsChoice,
  focusDeploy,
  busy,
  error,
  onDeploy,
  onDelete,
}: {
  application: ApplicationRow | null;
  /** La fiche rendue au serveur, si c'est bien celle de `application`. */
  record: ApplicationRecordView | null;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  targets: DeployTarget[];
  canDeploy: boolean;
  canDelete: boolean;
  canReadBackups: boolean;
  /** L'onglet « Sécurité » : ce qui bloque l'application, et ses failles acceptées. */
  canReadScans?: boolean;
  autoRollback: boolean;
  onAutoRollbackChange: (value: boolean) => void;
  /** Au premier déploiement : activer la sauvegarde. Rendu par la liste, posé ici. */
  backupChoice?: React.ReactNode;
  /** Les domaines, pour la cible choisie : ils dépendent de son reverse proxy. */
  domainsChoice?: (target: DeployTarget) => React.ReactNode;
  focusDeploy: boolean;
  busy: boolean;
  error: string | null;
  onDeploy: (targetId: string, runtime: 'docker' | 'k3s') => void;
  onDelete: () => void;
}) {
  const t = useT(messages);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [runtimeChoice, setRuntimeChoice] = useState<'docker' | 'k3s' | null>(null);
  // Par défaut : une cible où l'application est déjà en service, sinon la
  // première cible opérationnelle — jamais une machine injoignable par hasard
  // d'ordre alphabétique.
  const liveOn = new Set((application?.live ?? []).map((entry) => entry.targetName));
  const fallback = targets.find((candidate) => liveOn.has(candidate.name)) ?? targets[0];
  const target = targets.find((candidate) => candidate.id === targetId) ?? fallback;
  const runtime =
    runtimeChoice && target?.runtimes.includes(runtimeChoice) ? runtimeChoice : target?.runtimes[0];

  const ready = record !== null && application !== null && record.key === application.slug;

  const overview = application ? (
    <>
      {ready ? record.alerts : null}
      <DrawerSection title={t('drawer.run')}>
        <ServiceList application={application} />
      </DrawerSection>

      {application.live && application.live.length > 0 ? (
        <DrawerSection title={t('drawer.inService')}>
          <div className="card card-flat overflow-hidden">
            <ul className="list is-link">
              {application.live.map((entry) => (
                <li key={entry.id} className="relative">
                  <Led tone={HEALTH_TONE[entry.health] ?? 'idle'} />
                  <Link
                    href={`/apps?app=${entry.id}`}
                    className="mono text-[12.5px] text-text after:absolute after:inset-0"
                  >
                    {application.slug}@{entry.targetName}
                  </Link>
                  <span className="t-cap ml-auto text-text-3">
                    {t('drawer.inService.since', {
                      state: t(`health.${entry.health as 'healthy'}`),
                      ago: entry.ago ?? '—',
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </DrawerSection>
      ) : null}

      {canDeploy ? (
        <DrawerSection title={t('drawer.deploy')}>
          {targets.length === 0 ? (
            <p className="t-sm text-text-3">{t('drawer.deploy.noTarget')}</p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={t('drawer.deploy.target')}>
                  <Select
                    value={target?.id ?? ''}
                    onChange={(event) => setTargetId(event.target.value)}
                    autoFocus={focusDeploy}
                  >
                    {targets.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name} ·{' '}
                        {candidate.runtimes
                          .map((entry) =>
                            entry === 'docker'
                              ? `Docker ${candidate.dockerVersion ?? ''}`.trim()
                              : `K3s ${candidate.k3sVersion ?? ''}`.trim(),
                          )
                          .join(', ')}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('drawer.deploy.runtime')} help={t('drawer.deploy.runtime.help')}>
                  <Select
                    value={runtime ?? ''}
                    onChange={(event) => setRuntimeChoice(event.target.value as 'docker' | 'k3s')}
                  >
                    {(target?.runtimes ?? []).map((entry) => (
                      <option key={entry} value={entry}>
                        {t(`runtime.${entry}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <CheckboxField
                label={t('lifecycle.autoRollback')}
                help={t('lifecycle.autoRollback.on')}
                checked={autoRollback}
                onChange={(event) => onAutoRollbackChange(event.target.checked)}
              />
              {target && domainsChoice ? domainsChoice(target) : null}
              {backupChoice}
            </>
          )}
          {error ? <Alert variant="destructive">{error}</Alert> : null}
        </DrawerSection>
      ) : null}
    </>
  ) : null;

  const tabs: RecordTab[] = [
    { key: 'overview', label: t('record.tab.overview'), content: overview },
    ...SERVER_TABS.filter(
      (key) => (key !== 'backups' || canReadBackups) && (key !== 'security' || canReadScans),
    ).map((key) => ({
      key,
      label: t(`record.tab.${key}`),
      count: ready ? record.counts[key] : undefined,
      content: ready ? (record.tabs[key] ?? null) : undefined,
    })),
  ];

  return (
    <RecordDrawer
      open={application !== null}
      recordKey={application?.slug ?? null}
      onClose={onClose}
      onPrevious={onPrevious}
      onNext={onNext}
      label={application?.slug}
      tabsLabel={t('record.tabs')}
      tabs={tabs}
      header={
        application ? (
          <DrawerHeader
            icon={<Boxes className="!size-3.5" />}
            kind={t('drawer.kind')}
            route={application.name !== application.slug ? application.name : undefined}
            title={application.slug}
            state={
              <>
                <span className="mono text-text-2">{application.version}</span>
                <ServiceChips services={application.services} />
              </>
            }
            extra={
              application.description ? (
                <p className="t-sm text-text-2">{application.description}</p>
              ) : undefined
            }
          />
        ) : null
      }
      footer={(tab) =>
        application ? (
          <DrawerFooter
            end={
              canDelete ? (
                <Button variant="destructive" onClick={onDelete}>
                  {t('row.delete')}
                </Button>
              ) : null
            }
          >
            {tab === 'overview' && canDeploy && target && runtime ? (
              <Button loading={busy} onClick={() => onDeploy(target.id, runtime)}>
                {busy ? null : <Rocket aria-hidden />}
                {busy
                  ? t('action.sending')
                  : t('drawer.deploy.action', { version: application.version })}
              </Button>
            ) : null}
          </DrawerFooter>
        ) : null
      }
    />
  );
}
