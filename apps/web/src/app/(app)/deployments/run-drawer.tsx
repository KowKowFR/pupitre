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

/** The part of the record the server renders, as it travels all the way here. */
export type RunRecordView = Pick<RunRecord, 'key' | 'header' | 'body'>;

/**
 * A run's follow-up, in a drawer: its summary and its gestures, the pipeline,
 * the log stream, the scans and the frozen AppSpec — everything the run's page
 * used to be. The header reads from the row when it is shown, from the record
 * otherwise: a run opened from a link is not necessarily on the list's page.
 */
export function RunDrawer({
  selected,
  row,
  record,
  onClose,
  onPrevious,
  onNext,
}: {
  /** The requested run — row shown or not. */
  selected: string | null;
  row: DeploymentRow | null;
  /** The record rendered on the server, if it is indeed `selected`'s. */
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
