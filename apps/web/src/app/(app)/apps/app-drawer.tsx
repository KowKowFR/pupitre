'use client';

import { Activity } from 'lucide-react';
import { RecordDrawer } from '@/components/record-drawer';
import { Badge } from '@/components/ui/badge';
import { DrawerHeader } from '@/components/ui/drawer';
import { useT } from '@/i18n/client';
import { appConsole } from '@/i18n/messages/console';
import { HealthDot, type SupervisedRow } from './apps-table';
import type { RunningAppRecord } from './record/record';

/** The part of the record the server renders, as it travels all the way here. */
export type RunningAppRecordView = Pick<RunningAppRecord, 'key' | 'header' | 'actions' | 'body'>;

/**
 * A running application, in a drawer: what runs, what it says (the log stream),
 * what it consumes, and its gestures — everything its page used to be. The
 * header reads from the row when it is shown, from the record otherwise.
 */
export function AppDrawer({
  selected,
  row,
  record,
  onClose,
  onPrevious,
  onNext,
}: {
  selected: string | null;
  row: SupervisedRow | null;
  /** The record rendered on the server, if it is indeed `selected`'s. */
  record: RunningAppRecordView | null;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const t = useT(appConsole);
  const ready = record !== null && record.key === selected;
  const head = ready
    ? record.header
    : row
      ? {
          applicationSlug: row.applicationSlug,
          targetName: row.targetName,
          url: row.url,
          restored: row.status === 'rolled_back',
          health: row.healthStatus,
        }
      : null;

  return (
    <RecordDrawer
      open={selected !== null}
      recordKey={selected}
      onClose={onClose}
      onPrevious={onPrevious}
      onNext={onNext}
      label={head ? `${head.applicationSlug}@${head.targetName}` : undefined}
      tabsLabel={t('drawer.kind')}
      tabs={[
        {
          key: 'app',
          label: t('drawer.kind'),
          // The gestures first, across the whole width: it is a block that explains what
          // it allows, not a row of buttons.
          content: ready ? (
            <>
              {record.actions}
              {record.body}
            </>
          ) : undefined,
        },
      ]}
      header={
        <DrawerHeader
          icon={<Activity />}
          kind={t('drawer.kind')}
          route={head ? `@${head.targetName}` : undefined}
          title={head?.applicationSlug ?? t('drawer.kind')}
          extra={<p className="t-cap text-text-3">{t('page.description')}</p>}
          state={
            head ? (
              <>
                {head.health ? <HealthDot health={head.health} /> : null}
                {head.restored ? (
                  <Badge variant="warn" dot>
                    {t('page.restored')}
                  </Badge>
                ) : null}
                {head.url ? (
                  <a
                    href={head.url}
                    target="_blank"
                    rel="noreferrer"
                    className="link mono t-sm ml-auto break-all"
                  >
                    {head.url}
                  </a>
                ) : null}
              </>
            ) : undefined
          }
        />
      }
    />
  );
}
