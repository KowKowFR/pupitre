'use client';

import { useState } from 'react';
import type { AppSettings } from '@pupitre/core';
import { BrandMark } from '@/components/brand-mark';
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
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="field">
          <Label htmlFor="instanceName">{t('identity.name.label')}</Label>
          <Input
            id="instanceName"
            value={instanceName}
            maxLength={40}
            disabled={!canManage}
            onChange={(event) => setInstanceName(event.target.value)}
          />
          <p className="help">{t('identity.name.help')}</p>
        </div>
        <div className="field">
          <Label htmlFor="instanceTagline">{t('identity.tagline.label')}</Label>
          <Input
            id="instanceTagline"
            value={instanceTagline}
            maxLength={60}
            disabled={!canManage}
            placeholder={t('identity.tagline.placeholder')}
            onChange={(event) => setInstanceTagline(event.target.value)}
          />
          <p className="help">{t('identity.tagline.help')}</p>
        </div>
      </div>

      <div className="well">
        <div className="t-cap font-medium text-text-3">{t('identity.preview.title')}</div>
        <div className="mt-2 flex items-center gap-2.5">
          <BrandMark size={28} />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[14px] font-semibold text-text">
              {instanceName.trim() === '' ? t('identity.preview.nameRequired') : instanceName}
            </span>
            {instanceTagline.trim() === '' ? null : (
              <span className="t-cap truncate text-text-3">{instanceTagline}</span>
            )}
          </span>
        </div>
      </div>
    </SectionForm>
  );
}
