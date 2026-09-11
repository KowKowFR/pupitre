'use client';

import { useState } from 'react';
import type { AppSettings, DateStyleName, SupportedLocale } from '@tp/core';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
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

const DATE_STYLE_LABEL: Record<DateStyleName, string> = {
  short: 'court',
  medium: 'moyen',
  long: 'long',
};

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
  const patch = useSettingsPatch();
  const [timezone, setTimezone] = useState(settings.timezone);
  const [locale, setLocale] = useState<SupportedLocale>(settings.locale);
  const [dateStyle, setDateStyle] = useState<DateStyleName>(settings.dateStyle);
  const [timeStyle, setTimeStyle] = useState<DateStyleName>(settings.timeStyle);

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
        <div className="space-y-1.5">
          <Label htmlFor="timezone">Fuseau horaire</Label>
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
          <p className="text-xs text-ink-faint">
            Toujours explicite, jamais celui du navigateur : c&apos;est ce qui garantit que le
            serveur et le poste affichent la même heure pour le même événement. C&apos;est aussi le
            fuseau proposé par défaut à la création d&apos;une tâche planifiée — les tâches déjà
            installées gardent le leur.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="locale">Locale</Label>
          <Select
            id="locale"
            value={locale}
            disabled={!canManage}
            onChange={(event) => setLocale(event.target.value as SupportedLocale)}
          >
            {locales.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </Select>
          <p className="text-xs text-ink-faint">
            Décide de l&apos;ordre des composants et du nom des mois. Elle ne traduit pas le
            panel : son texte reste en français.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dateStyle">Style de date</Label>
          <Select
            id="dateStyle"
            value={dateStyle}
            disabled={!canManage}
            onChange={(event) => setDateStyle(event.target.value as DateStyleName)}
          >
            {dateStyles.map((style) => (
              <option key={style} value={style}>
                {DATE_STYLE_LABEL[style]}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="timeStyle">Style d&apos;heure</Label>
          <Select
            id="timeStyle"
            value={timeStyle}
            disabled={!canManage}
            onChange={(event) => setTimeStyle(event.target.value as DateStyleName)}
          >
            {dateStyles.map((style) => (
              <option key={style} value={style}>
                {DATE_STYLE_LABEL[style]}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="rounded-md border border-line bg-surface-2 px-3.5 py-3">
        <div className="eyebrow text-ink-faint">Aperçu</div>
        <div className="mt-1 font-mono text-sm text-ink tabular-nums">{preview}</div>
        <div className="mt-1 text-xs text-ink-faint">
          Instant de référence : 2026-01-15 14:32:07 UTC. L&apos;aperçu suit les champs
          ci-dessus avant même d&apos;enregistrer.
        </div>
      </div>
    </SectionForm>
  );
}
