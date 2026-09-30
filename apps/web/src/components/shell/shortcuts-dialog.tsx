'use client';

import { Fragment } from 'react';
import { Keyboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { useT } from '@/i18n/client';
import { chrome } from '@/i18n/messages/chrome';
import { common } from '@/i18n/messages/common';
import type { ShellSection } from './shell-provider';

/**
 * L'aide des raccourcis, ouverte par `?`. Elle ne liste que les sections que
 * la session peut ouvrir : un raccourci vers une page interdite n'existe pas.
 */
export function ShortcutsDialog({
  open,
  onOpenChange,
  sections,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sections: ShellSection[];
}) {
  const t = useT(chrome);
  const tc = useT(common);

  const rows: Array<{ keys: React.ReactNode; label: string }> = [
    {
      keys: (
        <>
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </>
      ),
      label: t('shortcuts.palette'),
    },
    ...sections
      .filter((section) => section.shortcut)
      .map((section) => ({
        keys: (
          <>
            <Kbd>G</Kbd>
            <span className="t-cap text-text-3">{t('shortcuts.then')}</span>
            <Kbd>{section.shortcut}</Kbd>
          </>
        ),
        label: t('shortcuts.goto', { section: t(`nav.${section.key}`) }),
      })),
    {
      keys: (
        <>
          <Kbd>J</Kbd>
          <Kbd>K</Kbd>
        </>
      ),
      label: t('shortcuts.rows'),
    },
    { keys: <Kbd>?</Kbd>, label: t('shortcuts.help') },
    { keys: <Kbd>esc</Kbd>, label: t('shortcuts.dismiss') },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="wide">
        <DialogHeader icon={<Keyboard />} tone="accent">
          <DialogTitle>{t('shortcuts.title')}</DialogTitle>
          <DialogDescription>{t('shortcuts.description')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <dl className="kv">
            {rows.map((row) => (
              <Fragment key={row.label}>
                <dt>{row.label}</dt>
                <dd>
                  <span className="inline-flex items-center gap-1">{row.keys}</span>
                </dd>
              </Fragment>
            ))}
          </dl>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {tc('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
