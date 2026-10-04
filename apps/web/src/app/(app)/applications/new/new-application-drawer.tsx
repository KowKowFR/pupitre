'use client';

import type { ProxyCapabilities } from '@pupitre/core';
import { Boxes } from 'lucide-react';
import { Drawer, DrawerHeader } from '@/components/ui/drawer';
import { useT } from '@/i18n/client';
import { applications as messages } from '@/i18n/messages/applications';
import type { NewApplicationAi } from '@/lib/new-application';
import { NewApplicationForm } from './new-application-form';

type DeployTarget = {
  id: string;
  name: string;
  host: string;
  runtimes: Array<'docker' | 'k3s'>;
  proxy: { description: string; capabilities: ProxyCapabilities; via?: string | null } | null;
};

/**
 * "New application", in a wide drawer above the list.
 *
 * Describe, generate, review, save, deploy: the journey and its routes do not
 * change. The drawer keeps the list behind, and the created application shows up
 * there as soon as it closes.
 */
export function NewApplicationDrawer({
  open,
  ai,
  targets,
  onClose,
  onSaved,
  backupOptions,
}: {
  open: boolean;
  ai: NewApplicationAi;
  targets: DeployTarget[];
  onClose: () => void;
  onSaved: (application: { id: string; name: string }) => void;
  backupOptions: { hasDestination: boolean } | null;
}) {
  const t = useT(messages);
  return (
    <Drawer
      open={open}
      onOpenChange={(next) => (next ? undefined : onClose())}
      wide
      label={t('action.new')}
    >
      {open ? (
        <>
          <DrawerHeader
            icon={<Boxes />}
            kind={t('drawer.kind')}
            title={t('action.new')}
            extra={<p className="t-sm text-text-2">{t('new.description')}</p>}
          />
          <NewApplicationForm
            {...ai}
            targets={targets}
            backupOptions={backupOptions}
            onSaved={onSaved}
            onCancel={onClose}
          />
        </>
      ) : null}
    </Drawer>
  );
}
