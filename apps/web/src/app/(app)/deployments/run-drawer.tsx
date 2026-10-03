'use client';

import { Rocket } from 'lucide-react';
import type { DeploymentStatus } from '@pupitre/core';
import { RecordDrawer } from '@/components/record-drawer';
import { DrawerHeader } from '@/components/ui/drawer';
import { useT } from '@/i18n/client';
import { deployments as messages } from '@/i18n/messages/deployments';
import type { DeploymentRow } from './deployments-table';
import type { RunRecord } from './record/record';
import { DeploymentStatusBadge } from './status-badge';

/** La part de la fiche que rend le serveur, telle qu'elle traverse jusqu'ici. */
export type RunRecordView = Pick<RunRecord, 'key' | 'header' | 'body'>;

/**
 * Le suivi d'un run, dans un tiroir : son résumé et ses gestes, le pipeline,
 * le flux de logs, les scans et l'AppSpec figée — tout ce qu'était la page
 * du run. L'en-tête se lit sur la ligne quand elle est affichée, sur la fiche
 * sinon : un run ouvert depuis un lien n'est pas forcément sur la page de la
 * liste.
 */
export function RunDrawer({
  selected,
  row,
  record,
  onClose,
  onPrevious,
  onNext,
}: {
  /** Le run demandé — ligne affichée ou non. */
  selected: string | null;
  row: DeploymentRow | null;
  /** La fiche rendue au serveur, si c'est bien celle de `selected`. */
  record: RunRecordView | null;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const t = useT(messages);
  const ready = record !== null && record.key === selected;
  const head: {
    applicationSlug: string;
    number: number;
    status: DeploymentStatus;
    targetName: string;
    runtime: string;
    specVersion: string | null;
  } | null = ready ? record.header : row ? { ...row, specVersion: null } : null;

  return (
    <RecordDrawer
      open={selected !== null}
      recordKey={selected}
      onClose={onClose}
      onPrevious={onPrevious}
      onNext={onNext}
      label={head ? `${head.applicationSlug} #${head.number}` : t('drawer.kind')}
      tabsLabel={t('tab.label')}
      tabs={[{ key: 'run', label: t('drawer.kind'), content: ready ? record.body : undefined }]}
      header={
        <DrawerHeader
          icon={<Rocket />}
          kind={t('drawer.kind')}
          route={head ? `#${head.number}` : undefined}
          title={
            head ? (
              <>
                {head.applicationSlug}{' '}
                {head.specVersion ? (
                  <span className="mono text-[16px] font-normal text-text-3">
                    {head.specVersion}
                  </span>
                ) : null}
              </>
            ) : (
              t('drawer.kind')
            )
          }
          state={
            head ? (
              <>
                <DeploymentStatusBadge status={head.status} />
                <span className="text-text-2">
                  <span className="mono">{head.targetName}</span> · {head.runtime}
                </span>
              </>
            ) : undefined
          }
        />
      }
    />
  );
}
