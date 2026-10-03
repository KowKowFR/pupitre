'use client';

import { Activity } from 'lucide-react';
import { RecordDrawer } from '@/components/record-drawer';
import { Badge } from '@/components/ui/badge';
import { DrawerHeader } from '@/components/ui/drawer';
import { useT } from '@/i18n/client';
import { appConsole } from '@/i18n/messages/console';
import { HealthDot, type SupervisedRow } from './apps-table';
import type { RunningAppRecord } from './record/record';

/** La part de la fiche que rend le serveur, telle qu'elle traverse jusqu'ici. */
export type RunningAppRecordView = Pick<RunningAppRecord, 'key' | 'header' | 'actions' | 'body'>;

/**
 * Une application en marche, dans un tiroir : ce qui tourne, ce que ça dit
 * (le flux de logs), ce que ça consomme, et ses gestes — tout ce qu'était sa
 * page. L'en-tête se lit sur la ligne quand elle est affichée, sur la fiche
 * sinon.
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
  /** La fiche rendue au serveur, si c'est bien celle de `selected`. */
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
          // Les gestes d'abord, sur toute la largeur : c'est un bloc qui
          // explique ce qu'il permet, pas une rangée de boutons.
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
