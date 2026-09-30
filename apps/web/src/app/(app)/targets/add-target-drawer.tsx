'use client';

import { Server } from 'lucide-react';
import { TargetHelp } from '@/components/target-help';
import { Drawer, DrawerHeader } from '@/components/ui/drawer';
import { useT } from '@/i18n/client';
import { targets as messages } from '@/i18n/messages/targets';
import { TargetForm, type CreatedTarget } from './target-form';

/**
 * « Ajouter une cible », dans un tiroir au-dessus de la liste.
 *
 * Le formulaire est celui de l'assistant de démarrage et de la modification :
 * `POST /api/targets`, mêmes champs, même audit. Le tiroir ne change que le
 * cadre — la liste reste derrière, et la cible créée s'y ouvre aussitôt,
 * prête à être testée.
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
              // Le formulaire demande une machine, un compte, une clé, une
              // plage de ports : l'aide dit ce qu'il faut avoir préparé en face.
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
