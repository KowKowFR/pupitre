'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Drawer } from '@/components/ui/drawer';
import { useT } from '@/i18n/client';
import { monitors as messages } from '@/i18n/messages/monitors';
import { toast } from '@/lib/toast';
import { MonitorForm, type EditableMonitor, type TypeOption } from '../monitor-form';

/**
 * « Modifier » sur la fiche d'une sonde : le formulaire de création, repris
 * avec les valeurs en place, dans un tiroir. La fiche reste derrière — on
 * corrige une cadence ou un seuil sans perdre des yeux la courbe qui l'a
 * motivé.
 */
export function MonitorEdit({ monitor, types }: { monitor: EditableMonitor; types: TypeOption[] }) {
  const t = useT(messages);
  const router = useRouter();
  // Une clé par ouverture : rouvrir repart des valeurs enregistrées, pas
  // d'une saisie abandonnée.
  const [openKey, setOpenKey] = React.useState<number | null>(null);

  return (
    <>
      <Button variant="secondary" onClick={() => setOpenKey((key) => (key ?? 0) + 1)}>
        <Pencil aria-hidden />
        {t('edit.action')}
      </Button>
      <Drawer
        open={openKey !== null}
        onOpenChange={(open) => (open ? undefined : setOpenKey(null))}
        wide
        label={t('edit.title', { name: monitor.name })}
      >
        {openKey !== null ? (
          <MonitorForm
            key={openKey}
            mode="edit"
            monitor={monitor}
            types={types}
            onDone={(name) => {
              setOpenKey(null);
              toast({ title: t('toast.updated', { name }), tone: 'ok' });
              router.refresh();
            }}
          />
        ) : null}
      </Drawer>
    </>
  );
}
