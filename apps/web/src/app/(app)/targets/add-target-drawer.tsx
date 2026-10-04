'use client';

import { Server } from 'lucide-react';
import { TargetHelp } from '@/components/target-help';
import { Drawer, DrawerHeader } from '@/components/ui/drawer';
import { useT } from '@/i18n/client';
import { targets as messages } from '@/i18n/messages/targets';
import { TargetForm, type CreatedTarget } from './target-form';

/**
 * "Add a target", in a drawer above the list.
 *
 * The form is the onboarding assistant's and the edit's: `POST /api/targets`,
 * same fields, same audit. The drawer only changes the frame — the list stays
 * behind, and the created target opens there right away, ready to be tested.
 */
export function AddTargetDrawer({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (target: CreatedTarget) => void;
}) {
  const t = useT(messages);
  return (
    <Drawer
      open={open}
      onOpenChange={(next) => (next ? undefined : onClose())}
      wide
      label={t('page.add')}
    >
      {open ? (
        <>
          <DrawerHeader
            icon={<Server />}
            kind={t('drawer.kind')}
            title={t('page.add')}
            extra={
              // The form asks for a machine, an account, a key, a port range: the help says
              // what must have been prepared on the other side.
              <div className="flex flex-col items-start gap-2">
                <p className="t-sm text-text-2">{t('new.description')}</p>
                <p className="t-cap text-text-3">{t('new.card.description')}</p>
                <TargetHelp />
              </div>
            }
          />
          <TargetForm frame="drawer" onCreated={onCreated} onCancel={onClose} />
        </>
      ) : null}
    </Drawer>
  );
}
