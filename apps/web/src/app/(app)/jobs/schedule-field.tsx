'use client';

import {
  SIMPLE_INTERVAL_MINUTES,
  SIMPLE_SCHEDULE_KINDS,
  browserTimeZone,
  cronError,
  describeCron,
  fromCron,
  nextRuns,
  toCron,
  type SimpleSchedule,
  type SimpleScheduleKind,
} from '@pupitre/core/schedule';
import type { Translate } from '@pupitre/core';
import { useMemo, useSyncExternalStore } from 'react';
import { Alert } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioOption } from '@/components/ui/radio';
import { Select } from '@/components/ui/select';
import { useLanguage, useT } from '@/i18n/client';
import { jobs as messages } from '@/i18n/messages/jobs';
import { formatDateTimeWith, type FormatSettings } from '@/lib/format';

/**
 * Entering a cadence: a simplified schedule or a cron expression.
 *
 * The simple mode is an **input layer**. It does not produce a second format:
 * `toCron()` converts it into a cron expression, the only thing that goes to the
 * server and ends up in the database. Conversely, an existing cadence is read
 * back by `fromCron()`; when it has no simple equivalent, the screen says so and
 * stays in expert mode rather than show an approximation.
 *
 * A controlled component: all the state lives with the caller, which avoids
 * having to resynchronize an internal state on a prop in an effect.
 */

export type ScheduleDraft = {
  mode: 'simple' | 'expert';
  /** The simple mode's state. Always defined, even in expert mode. */
  simple: SimpleSchedule;
  /** The expert mode's state: free text, possibly invalid. */
  cron: string;
  /**
   * The time zone in which the expression will be interpreted by BullMQ. Carried
   * by the draft like the cadence itself: the two make a time, and a time without
   * a time zone means nothing.
   */
  timeZone: string;
};

const DEFAULT_SIMPLE: SimpleSchedule = { kind: 'daily', hour: 3, minute: 0 };

/** The draft's effective cadence, in the format the database stores. */
export function draftCron(draft: ScheduleDraft): string {
  return draft.mode === 'simple' ? toCron(draft.simple) : draft.cron.trim();
}

/**
 * The request body corresponding to the draft.
 *
 * In simple mode we send the schedule and it is the **server** that converts it:
 * a client does not decide what is written to the database, even when it can
 * compute the same thing.
 */
export function draftBody(
  draft: ScheduleDraft,
): ({ schedule: SimpleSchedule } | { cron: string }) & { timezone: string } {
  const cadence =
    draft.mode === 'simple' ? { schedule: draft.simple } : { cron: draft.cron.trim() };
  return { ...cadence, timezone: draft.timeZone };
}

/** Ouverture d'une cadence existante : mode simple si `fromCron` y arrive. */
export function draftFromCron(cron: string, timeZone: string): ScheduleDraft {
  const simple = fromCron(cron);
  return {
    mode: simple ? 'simple' : 'expert',
    simple: simple ?? DEFAULT_SIMPLE,
    cron,
    timeZone,
  };
}

// ─── screen vocabulary ────────────────────────────────────────────────────────

type Messages = Translate<(typeof messages)['fr']>;

/**
 * Monday first: it is the order expected here, not cron's. The order is a
 * property of the screen, not of the language — it does not move from one locale
 * to another, only the initials change.
 */
const WEEKDAY_VALUES = [1, 2, 3, 4, 5, 6, 0] as const;

type WeekdayValue = (typeof WEEKDAY_VALUES)[number];

const pad2 = (value: number): string => String(value).padStart(2, '0');

function hourAndMinuteOf(simple: SimpleSchedule): { hour: number; minute: number } {
  if (simple.kind === 'interval') return { hour: 3, minute: 0 };
  if (simple.kind === 'hourly') return { hour: 3, minute: simple.minute };
  return { hour: simple.hour, minute: simple.minute };
}

/** Changing schedule: the time already entered is kept. */
function withKind(previous: SimpleSchedule, kind: SimpleScheduleKind): SimpleSchedule {
  const { hour, minute } = hourAndMinuteOf(previous);
  switch (kind) {
    case 'interval':
      return { kind: 'interval', everyMinutes: 15 };
    case 'hourly':
      return { kind: 'hourly', minute };
    case 'daily':
      return { kind: 'daily', hour, minute };
    case 'weekly':
      return { kind: 'weekly', weekdays: [1], hour, minute };
    case 'monthly':
      return { kind: 'monthly', day: 1, hour, minute };
  }
}

// ─── horloge ──────────────────────────────────────────────────────────────────

const TICK_MS = 30_000;

function subscribeToTick(onChange: () => void): () => void {
  const id = setInterval(onChange, TICK_MS);
  return () => clearInterval(id);
}

/** Quantized: `getSnapshot` must return the same value as long as nothing moves. */
function browserNow(): number {
  return Math.floor(Date.now() / TICK_MS) * TICK_MS;
}

function noNow(): null {
  return null;
}

/**
 * `null` on the server side, and at the first client render.
 *
 * The preview depends on the current time: rendering it during SSR would produce
 * a text the hydration would contradict right away. `useSyncExternalStore` gives
 * exactly this contract, without `setState` in an effect.
 */
function useNow(): number | null {
  return useSyncExternalStore(subscribeToTick, browserNow, noNow);
}

// ─── preview ──────────────────────────────────────────────────────────────────

/**
 * An upcoming occurrence, in an **explicit** time zone — the task's, or the
 * reader's — and in the instance's locale. The time zone is the subject of this
 * preview, so it is always spelled out; the locale, for its part, was
 * short-circuited and served `en-GB` to an `en-US` instance.
 */
function formatIn(date: Date, timeZone: string, format: FormatSettings): string {
  return formatDateTimeWith(date, format, { dateStyle: 'short', timeStyle: 'short', timeZone });
}

function SchedulePreview({
  cron,
  timeZone,
  format,
}: {
  cron: string;
  timeZone: string;
  format: FormatSettings;
}) {
  const t = useT(messages);
  const language = useLanguage();
  const now = useNow();
  const error = cron.length === 0 ? t('preview.emptyCron') : cronError(cron, language);

  const runs = useMemo(
    () =>
      error || now === null ? [] : nextRuns(cron, { from: new Date(now), count: 3, timeZone }),
    [cron, error, now, timeZone],
  );

  if (error) {
    return (
      <Alert variant="destructive" className="mt-1">
        {t('preview.refused', { error })}
      </Alert>
    );
  }

  // Only read once the clock is available: on the server side, the rendering's
  // time zone is nobody's.
  const viewerZone = now === null ? null : browserTimeZone();
  const differentZone = viewerZone !== null && viewerZone !== timeZone;

  const [first, ...rest] = runs;

  return (
    <div className="well flex flex-col gap-1">
      <span className="t-cap text-text-3">{t('preview.title')}</span>
      <span className="t-sm text-text-2">{describeCron(cron, { locale: language, timeZone })}</span>
      {now === null ? (
        <span className="t-sm text-text-3">{t('preview.computing')}</span>
      ) : first === undefined ? (
        <span className="t-sm text-text-3">{t('preview.noRun')}</span>
      ) : (
        <>
          <span className="t-sm">
            <strong>{t('preview.next')} :</strong>{' '}
            <span className="mono">{formatIn(first, timeZone, format)}</span>{' '}
            <span className="text-text-3">{timeZone}</span>
            {differentZone && viewerZone ? (
              <span className="text-text-3">
                {' · '}
                {t('row.yourClock', { clock: formatIn(first, viewerZone, format) })}
              </span>
            ) : null}
          </span>
          {rest.length > 0 ? (
            <span className="t-sm">
              <strong>{t('preview.list')} :</strong>{' '}
              <span className="mono">
                {rest.map((run) => formatIn(run, timeZone, format)).join(', ')}
              </span>
            </span>
          ) : null}
        </>
      )}
      <span className="mono t-cap text-text-3">{cron}</span>
    </div>
  );
}

// ─── champ ────────────────────────────────────────────────────────────────────

export function ScheduleField({
  idPrefix,
  value,
  onChange,
  timeZones,
  format,
  disabled = false,
}: {
  /** Identifier prefix: the field appears twice on the same page. */
  idPrefix: string;
  value: ScheduleDraft;
  onChange: (next: ScheduleDraft) => void;
  /** The instance's locale and time zone, for the preview of the next occurrences. */
  format: FormatSettings;
  /**
   * Offered time zones, listed **on the server side**: it is the process's ICU that
   * will validate the input, offering the browser's would lead to choices refused
   * at save time.
   */
  timeZones: readonly string[];
  disabled?: boolean;
}) {
  const t = useT(messages);
  const language = useLanguage();
  const cron = draftCron(value);
  const timeZone = value.timeZone;
  const expertHasSimpleForm = fromCron(value.cron.trim()) !== null;

  const setSimple = (simple: SimpleSchedule): void => onChange({ ...value, simple });

  const setMode = (mode: 'simple' | 'expert'): void => {
    if (mode === value.mode) return;
    if (mode === 'expert') {
      // We take the current cadence along rather than start again from an empty field.
      onChange({ ...value, mode, cron: toCron(value.simple) });
      return;
    }
    // If the typed expression has a simple equivalent, we adopt it; otherwise we keep
    // the last simple schedule chosen, and the cron is overwritten — that is what the
    // notice under the field announces.
    const parsed = fromCron(value.cron.trim());
    onChange({ ...value, mode, simple: parsed ?? value.simple });
  };

  const { simple } = value;
  const time = hourAndMinuteOf(simple);

  return (
    <div className="flex flex-col gap-3">
      <RadioGroup aria-label={t('field.mode.aria')} className="grid w-full grid-cols-2">
        <RadioOption
          name={`${idPrefix}-mode`}
          label={t('field.mode.simple')}
          value="simple"
          checked={value.mode === 'simple'}
          disabled={disabled}
          onChange={() => setMode('simple')}
        />
        <RadioOption
          name={`${idPrefix}-mode`}
          label={t('field.mode.expert')}
          value="expert"
          checked={value.mode === 'expert'}
          disabled={disabled}
          onChange={() => setMode('expert')}
        />
      </RadioGroup>

      {value.mode === 'simple' ? (
        <>
          <div className="field">
            <Label htmlFor={`${idPrefix}-kind`}>{t('field.kind.label')}</Label>
            <Select
              id={`${idPrefix}-kind`}
              value={simple.kind}
              disabled={disabled}
              onChange={(event) =>
                setSimple(withKind(simple, event.target.value as SimpleScheduleKind))
              }
            >
              {SIMPLE_SCHEDULE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`field.kind.${kind}`)}
                </option>
              ))}
            </Select>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {simple.kind === 'interval' ? (
              <Select
                aria-label={t('field.interval.aria')}
                className="w-auto"
                value={String(simple.everyMinutes)}
                disabled={disabled}
                onChange={(event) =>
                  setSimple({
                    kind: 'interval',
                    everyMinutes: Number(
                      event.target.value,
                    ) as (typeof SIMPLE_INTERVAL_MINUTES)[number],
                  })
                }
              >
                {SIMPLE_INTERVAL_MINUTES.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {t('field.interval.option', { minutes })}
                  </option>
                ))}
              </Select>
            ) : null}

            {simple.kind === 'hourly' ? (
              <label className="t-sm flex items-center gap-2 text-text-3">
                {t('field.hourly.atMinute')}
                <Input
                  type="number"
                  min={0}
                  max={59}
                  className="input-sm mono w-20"
                  value={simple.minute}
                  disabled={disabled}
                  onChange={(event) =>
                    setSimple({ kind: 'hourly', minute: clamp(event.target.value, 0, 59) })
                  }
                />
              </label>
            ) : null}

            {simple.kind === 'monthly' ? (
              <label className="t-sm flex items-center gap-2 text-text-3">
                {t('field.monthly.onDay')}
                <Input
                  type="number"
                  min={1}
                  max={31}
                  className="input-sm mono w-20"
                  value={simple.day}
                  disabled={disabled}
                  onChange={(event) =>
                    setSimple({ ...simple, day: clamp(event.target.value, 1, 31) })
                  }
                />
              </label>
            ) : null}

            {simple.kind === 'weekly' ? (
              <div
                className="flex flex-wrap gap-1.5"
                role="group"
                aria-label={t('field.weekdays.aria')}
              >
                {WEEKDAY_VALUES.map((day) => (
                  <DayToggle
                    key={day}
                    short={weekdayShort(day, t)}
                    long={weekdayLong(day, t)}
                    checked={simple.weekdays.includes(day)}
                    // Unchecking the last day would give a week without an occurrence.
                    disabled={
                      disabled || (simple.weekdays.length === 1 && simple.weekdays[0] === day)
                    }
                    onChange={(checked) => {
                      const weekdays = checked
                        ? [...simple.weekdays, day].sort((a, b) => a - b)
                        : simple.weekdays.filter((entry) => entry !== day);
                      if (weekdays.length > 0) setSimple({ ...simple, weekdays });
                    }}
                  />
                ))}
              </div>
            ) : null}

            {simple.kind !== 'interval' && simple.kind !== 'hourly' ? (
              <label className="t-sm ml-1.5 flex items-center gap-2 text-text-3">
                {t('field.time.at')}
                <Input
                  type="time"
                  className="input-sm mono w-24"
                  value={`${pad2(time.hour)}:${pad2(time.minute)}`}
                  disabled={disabled}
                  onChange={(event) => {
                    const [hour, minute] = event.target.value.split(':');
                    if (hour === undefined || minute === undefined) return;
                    setSimple({
                      ...simple,
                      hour: clamp(hour, 0, 23),
                      minute: clamp(minute, 0, 59),
                    });
                  }}
                />
              </label>
            ) : null}
          </div>
        </>
      ) : (
        <div className="field">
          <Label htmlFor={`${idPrefix}-cron`}>{t('field.label')}</Label>
          <Input
            id={`${idPrefix}-cron`}
            aria-label={t('field.cron.aria')}
            className="mono"
            placeholder="0 3 * * 1"
            value={value.cron}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, cron: event.target.value })}
          />
        </div>
      )}

      {value.mode === 'expert' &&
      !expertHasSimpleForm &&
      cronError(value.cron.trim(), language) === null ? (
        <p className="help">{t('field.expertNoSimple')}</p>
      ) : null}

      {simple.kind === 'monthly' && value.mode === 'simple' && simple.day > 28 ? (
        <p className="t-cap text-warn-text">{t('field.shortMonths', { day: simple.day })}</p>
      ) : null}

      <div className="field">
        <Label htmlFor={`${idPrefix}-tz`}>{t('field.timeZone.label')}</Label>
        <Select
          id={`${idPrefix}-tz`}
          value={timeZone}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, timeZone: event.target.value })}
        >
          {/* The saved time zone may have disappeared from the current ICU: we keep
              it at the top of the list rather than replace it silently. */}
          {timeZones.includes(timeZone) ? null : (
            <option value={timeZone}>{t('field.timeZone.unknown', { zone: timeZone })}</option>
          )}
          {timeZones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </Select>
        {dependsOnTimeZone(value) ? null : (
          <span className="help">{t('field.timeZone.irrelevant')}</span>
        )}
      </div>

      <SchedulePreview cron={cron} timeZone={timeZone} format={format} />
    </div>
  );
}

/**
 * A day of the week, as a round chip: filled when it is selected. A real checkbox
 * underneath, for the keyboard and screen readers.
 */
function DayToggle({
  short,
  long,
  checked,
  disabled,
  onChange,
}: {
  short: string;
  long: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label title={long} className="relative inline-flex cursor-pointer">
      <input
        type="checkbox"
        className="peer sr-only"
        aria-label={long}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span
        aria-hidden
        className="flex size-[30px] items-center justify-center rounded-full border border-border-strong bg-surface text-[12px] font-semibold text-text-2 transition-colors peer-checked:border-accent peer-checked:bg-accent peer-checked:text-white peer-focus-visible:shadow-focus peer-disabled:cursor-not-allowed motion-reduce:transition-none"
      >
        {short}
      </span>
    </label>
  );
}

/**
 * A cadence whose time is fixed depends on the time zone; an interval in minutes
 * does not — saying so avoids suggesting a setting without effect.
 */
function dependsOnTimeZone(draft: ScheduleDraft): boolean {
  const simple = fromCron(draftCron(draft));
  if (!simple) return true;
  return simple.kind !== 'interval' && simple.kind !== 'hourly';
}

/** A day's initial, as the checkbox shows it. */
function weekdayShort(day: WeekdayValue, t: Messages): string {
  return t(`weekday.${day}.short`);
}

/** Its full name, for the screen reader and the tooltip. */
function weekdayLong(day: WeekdayValue, t: Messages): string {
  return t(`weekday.${day}.long`);
}

function clamp(raw: string | number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
