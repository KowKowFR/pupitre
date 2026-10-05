'use client';

import { useState } from 'react';
import {
  LOCALE_LABELS,
  type AppSettings,
  type DateStyleName,
  type SupportedLocale,
} from '@pupitre/core';
import { HelpTip } from '@/components/ui/help-tip';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useT } from '@/i18n/client';
import { settings as messages } from '@/i18n/messages/settings';
import { formatDateTime } from '@/lib/format';
import { SectionForm } from '../section-form';
import { useSettingsPatch } from '../use-settings-patch';

/**
 * The preview's reference instant.
 *
 * Fixed, and not `new Date()`: the preview is rendered on the server then
 * rehydrated on the client, and two calls to `new Date()` a few hundred
 * milliseconds apart would produce two different strings — hence a hydration
 * error. A frozen instant shows exactly what we want to show: the time zone's
 * offset and the rendering's shape.
 */
const PREVIEW_INSTANT = new Date('2026-01-15T14:32:07Z');

/**
 * It is here, and nowhere else, that the panel's language is chosen.
 *
 * No "Language" section next to "Regional settings": it would be two screens for
 * a single question. The locale already decided the months' names and the
 * day/month order; it now decides the words too. A single setting, hence a
 * single possible state — never an English panel dating its lines in French.
 *
 * The offered list is no longer `SUPPORTED_LOCALES` but `TRANSLATED_LOCALES`:
 * only the languages the panel really speaks are offered. An instance that still
 * carries `de-DE` in the database keeps its value — it then appears in the list,
 * once, so that one can leave it.
 */
export function RegionalForm({
  settings,
  timezones,
  locales,
  dateStyles,
  canManage,
}: {
  settings: AppSettings;
  timezones: string[];
  locales: SupportedLocale[];
  dateStyles: DateStyleName[];
  canManage: boolean;
}) {
  const t = useT(messages);
  const patch = useSettingsPatch();
  const [timezone, setTimezone] = useState(settings.timezone);
  const [locale, setLocale] = useState<SupportedLocale>(settings.locale);
  const [dateStyle, setDateStyle] = useState<DateStyleName>(settings.dateStyle);
  const [timeStyle, setTimeStyle] = useState<DateStyleName>(settings.timeStyle);

  const styleLabel: Record<DateStyleName, string> = {
    short: t('regional.style.short'),
    medium: t('regional.style.medium'),
    long: t('regional.style.long'),
  };

  // Preview derived from the current state, recomputed at each render: no effect,
  // no mirror state to resynchronize.
  const preview = formatDateTime(PREVIEW_INSTANT, { timezone, locale, dateStyle, timeStyle });

  function reset() {
    setTimezone(settings.timezone);
    setLocale(settings.locale);
    setDateStyle(settings.dateStyle);
    setTimeStyle(settings.timeStyle);
    patch.clearFeedback();
  }

  return (
    <SectionForm
      patch={patch}
      canManage={canManage}
      onReset={reset}
      onSubmit={() => void patch.save({ timezone, locale, dateStyle, timeStyle })}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="field">
          <Label htmlFor="timezone">
            {t('regional.timezone.label')}
            <HelpTip>{t('regional.timezone.help')}</HelpTip>
          </Label>
          <Select
            id="timezone"
            value={timezone}
            disabled={!canManage}
            onChange={(event) => setTimezone(event.target.value)}
          >
            {timezones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </Select>
        </div>
        <div className="field">
          <Label htmlFor="locale">
            {t('regional.locale.label')}
            <HelpTip>{t('regional.locale.help')}</HelpTip>
          </Label>
          <Select
            id="locale"
            value={locale}
            disabled={!canManage}
            onChange={(event) => setLocale(event.target.value as SupportedLocale)}
          >
            {locales.map((item) => (
              <option key={item} value={item}>
                {LOCALE_LABELS[item]}
              </option>
            ))}
          </Select>
        </div>
        <div className="field">
          <Label htmlFor="dateStyle">{t('regional.dateStyle.label')}</Label>
          <Select
            id="dateStyle"
            value={dateStyle}
            disabled={!canManage}
            onChange={(event) => setDateStyle(event.target.value as DateStyleName)}
          >
            {dateStyles.map((style) => (
              <option key={style} value={style}>
                {styleLabel[style]}
              </option>
            ))}
          </Select>
        </div>
        <div className="field">
          <Label htmlFor="timeStyle">{t('regional.timeStyle.label')}</Label>
          <Select
            id="timeStyle"
            value={timeStyle}
            disabled={!canManage}
            onChange={(event) => setTimeStyle(event.target.value as DateStyleName)}
          >
            {dateStyles.map((style) => (
              <option key={style} value={style}>
                {styleLabel[style]}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="well">
        <div className="t-cap font-medium text-text-3">{t('regional.preview.title')}</div>
        <div className="mt-1 mono text-sm text-text tabular-nums">{preview}</div>
        <div className="help mt-1">{t('regional.preview.help')}</div>
      </div>
    </SectionForm>
  );
}
