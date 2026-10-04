'use client';

import type { ReactNode } from 'react';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { SettingsPatch } from './use-settings-patch';

/**
 * The common envelope of an editable subsection: the two feedback banners, and
 * the Save / Cancel pair.
 *
 * A real `<form>`, not a `<div>` with a button: the Enter key in a field saves,
 * which is what one expects from a settings form, and the submit button is
 * announced as such.
 *
 * Without `settings:manage`, there is no action bar at all. The notice that
 * explains it is set once and for all by the section's layout: repeating it on
 * each panel would be noise.
 */
export function SectionForm({
  patch,
  canManage,
  onSubmit,
  onReset,
  children,
}: {
  patch: SettingsPatch;
  canManage: boolean;
  onSubmit: () => void;
  onReset: () => void;
  children: ReactNode;
}) {
  const t = useT(common);

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {patch.error ? <Alert variant="destructive">{patch.error}</Alert> : null}

      {children}

      {canManage ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle pt-4">
          <Button type="submit" loading={patch.pending}>
            {patch.pending ? t('saving') : t('save')}
          </Button>
          <Button type="button" variant="ghost" disabled={patch.pending} onClick={onReset}>
            {t('reset')}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
