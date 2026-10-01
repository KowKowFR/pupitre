'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Boxes, Rocket } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CheckboxField } from '@/components/ui/checkbox';
import {
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerSection,
} from '@/components/ui/drawer';
import { Field } from '@/components/ui/field';
import { Led, type Tone } from '@/components/ui/led';
import { Select } from '@/components/ui/select';
import { useT } from '@/i18n/client';
import { applications as messages } from '@/i18n/messages/applications';
import { ServiceChips, type ApplicationRow, type DeployTarget } from './applications-view';
import { ServiceList } from './service-list';

const HEALTH_TONE: Record<string, Tone> = {
  healthy: 'ok',
  unhealthy: 'warn',
  unreachable: 'danger',
  unknown: 'idle',
};

/**
 * L'aperçu d'une application : ce qui va tourner, relu depuis l'AppSpec, où
 * elle est en service, et un déploiement rapide. Le choix de la cible borne
 * celui du runtime : on ne propose que ce que le preflight a vu.
 */
export function ApplicationDrawer({
  application,
  onOpenChange,
  onPrevious,
  onNext,
  targets,
  canDeploy,
  canDelete,
  autoRollback,
  onAutoRollbackChange,
  backupChoice,
  focusDeploy,
  busy,
  error,
  onDeploy,
  onDelete,
}: {
  application: ApplicationRow | null;
  onOpenChange: (open: boolean) => void;
  onPrevious?: () => void;
  onNext?: () => void;
  targets: DeployTarget[];
  canDeploy: boolean;
  canDelete: boolean;
  autoRollback: boolean;
  onAutoRollbackChange: (value: boolean) => void;
  /** Au premier déploiement : activer la sauvegarde. Rendu par la liste, posé ici. */
  backupChoice?: React.ReactNode;
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

  if (!application)
    return (
      <Drawer open={false} onOpenChange={onOpenChange}>
        {null}
      </Drawer>
    );

  return (
    <Drawer
      open
      onOpenChange={onOpenChange}
      onPrevious={onPrevious}
      onNext={onNext}
      recordHref={`/applications/${application.id}`}
    >
      <DrawerHeader
        icon={<Boxes className="!size-3.5" />}
        kind={t('drawer.kind')}
        route={`/applications/${application.slug}`}
        title={application.slug}
        state={
          <>
            <span className="mono text-text-2">{application.version}</span>
            <ServiceChips services={application.services} />
          </>
        }
      />

      <DrawerBody>
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
                      href={`/apps/${entry.id}`}
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
                {backupChoice}
              </>
            )}
            {error ? <Alert variant="destructive">{error}</Alert> : null}
          </DrawerSection>
        ) : null}
      </DrawerBody>

      <DrawerFooter
        end={
          canDelete ? (
            <Button variant="destructive" onClick={onDelete}>
              {t('row.delete')}
            </Button>
          ) : null
        }
      >
        {canDeploy && target && runtime ? (
          <Button loading={busy} onClick={() => onDeploy(target.id, runtime)}>
            {busy ? null : <Rocket aria-hidden />}
            {busy
              ? t('action.sending')
              : t('drawer.deploy.action', { version: application.version })}
          </Button>
        ) : null}
        <Button variant="secondary" asChild>
          <Link href={`/applications/${application.id}`}>{t('row.open')}</Link>
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
