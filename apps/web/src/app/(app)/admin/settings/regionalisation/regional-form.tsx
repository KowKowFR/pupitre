'use client';

import { useState } from 'react';
import {
  LOCALE_LABELS,
  type AppSettings,
  type DateStyleName,
  type SupportedLocale,
} from '@pupitre/core';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useT } from '@/i18n/client';
import { settings as messages } from '@/i18n/messages/settings';
import { formatDateTime } from '@/lib/format';
import { SectionForm } from '../section-form';
import { useSettingsPatch } from '../use-settings-patch';

/**
 * Instant de référence de l'aperçu.
 *
 * Fixe, et non `new Date()` : l'aperçu est rendu côté serveur puis réhydraté
 * côté client, et deux appels à `new Date()` séparés de quelques centaines de
 * millisecondes produiraient deux chaînes différentes — donc une erreur
 * d'hydratation. Un instant figé montre exactement ce qu'on veut montrer : le
 * décalage du fuseau et la forme du rendu.
 */
const PREVIEW_INSTANT = new Date('2026-01-15T14:32:07Z');

/**
 * C'est ici, et nulle part ailleurs, que la langue du panel se choisit.
 *
 * Pas de section « Langue » à côté de « Régionalisation » : ce serait deux
 * écrans pour une seule question. La locale décidait déjà du nom des mois et
 * de l'ordre jour/mois ; elle décide maintenant aussi des mots. Un seul
 * réglage, donc un seul état possible — jamais un panel anglais qui daterait
 * ses lignes en français.
 *
 * La liste proposée n'est plus `SUPPORTED_LOCALES` mais `TRANSLATED_LOCALES` :
 * on n'offre que les langues que le panel parle réellement. Une instance qui
 * porte encore `de-DE` en base garde sa valeur — elle apparaît alors dans la
 * liste, une fois, pour qu'on puisse en sortir.
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

  // Aperçu dérivé de l'état courant, recalculé à chaque rendu : pas d'effet, pas
  // d'état miroir à resynchroniser.
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
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="field">
          <Label htmlFor="timezone">{t('regional.timezone.label')}</Label>
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
          <p className="help">{t('regional.timezone.help')}</p>
        </div>
        <div className="field">
          <Label htmlFor="locale">{t('regional.locale.label')}</Label>
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
          <p className="help">{t('regional.locale.help')}</p>
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
