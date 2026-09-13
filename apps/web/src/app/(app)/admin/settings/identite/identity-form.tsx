'use client';

import { useState } from 'react';
import type { AppSettings } from '@pupitre/core';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useT } from '@/i18n/client';
import { settings as messages } from '@/i18n/messages/settings';
import { SectionForm } from '../section-form';
import { useSettingsPatch } from '../use-settings-patch';

/**
 * Identité de l'instance : deux champs, et rien d'autre.
 *
 * Le corps du PATCH ne nomme que ces deux champs. Renommer le panel ne doit
 * pas pouvoir toucher au seuil de blocage des scans.
 */
export function IdentityForm({
  settings,
  canManage,
}: {
  settings: AppSettings;
  canManage: boolean;
}) {
  const t = useT(messages);
  const patch = useSettingsPatch();
  const [instanceName, setInstanceName] = useState(settings.instanceName);
  const [instanceTagline, setInstanceTagline] = useState(settings.instanceTagline);

  function reset() {
    setInstanceName(settings.instanceName);
    setInstanceTagline(settings.instanceTagline);
    patch.clearFeedback();
  }

  return (
    <SectionForm
      patch={patch}
      canManage={canManage}
      onReset={reset}
      onSubmit={() => void patch.save({ instanceName, instanceTagline })}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="instanceName">{t('identity.name.label')}</Label>
          <Input
            id="instanceName"
            value={instanceName}
            maxLength={40}
            disabled={!canManage}
            onChange={(event) => setInstanceName(event.target.value)}
          />
          <p className="text-xs text-ink-faint">{t('identity.name.help')}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="instanceTagline">{t('identity.tagline.label')}</Label>
          <Input
            id="instanceTagline"
            value={instanceTagline}
            maxLength={60}
            disabled={!canManage}
            placeholder={t('identity.tagline.placeholder')}
            onChange={(event) => setInstanceTagline(event.target.value)}
          />
          <p className="text-xs text-ink-faint">{t('identity.tagline.help')}</p>
        </div>
      </div>

      <div className="rounded-md border border-line bg-surface-2 px-3.5 py-3">
        <div className="eyebrow text-ink-faint">{t('identity.preview.title')}</div>
        <div className="mt-2 flex items-center gap-2.5">
          <span
            aria-hidden
            className="flex size-7 shrink-0 items-center justify-center rounded-[5px] bg-signal shadow-panel"
          >
            <span className="size-2 rounded-[1px] bg-signal-ink" />
          </span>
          <span className="flex min-w-0 flex-col leading-none">
            <span className="truncate font-condensed text-[0.9375rem] font-semibold tracking-[0.01em] text-ink">
              {instanceName.trim() === '' ? t('identity.preview.nameRequired') : instanceName}
            </span>
            {instanceTagline.trim() === '' ? null : (
              <span className="eyebrow truncate pt-1 text-ink-faint">{instanceTagline}</span>
            )}
          </span>
        </div>
      </div>
    </SectionForm>
  );
}
