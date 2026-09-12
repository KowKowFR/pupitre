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
import { useMemo, useSyncExternalStore } from 'react';
import { Alert } from '@/components/ui/alert';
import { CheckboxChip } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioOption } from '@/components/ui/radio';
import { Select } from '@/components/ui/select';

/**
 * Saisie d'une cadence : périodicité simplifiée ou expression cron.
 *
 * Le mode simple est une **surcouche de saisie**. Il ne produit pas un second
 * format : `toCron()` le convertit en expression cron, seule chose qui parte au
 * serveur et finisse en base. Réciproquement, une cadence existante est relue
 * par `fromCron()` ; quand elle n'a pas d'équivalent simple, l'écran le dit et
 * reste en mode expert plutôt que d'afficher une approximation.
 *
 * Composant contrôlé : tout l'état vit chez l'appelant, ce qui évite d'avoir à
 * resynchroniser un état interne sur une prop dans un effet.
 */

export type ScheduleDraft = {
  mode: 'simple' | 'expert';
  /** État du mode simple. Toujours défini, même en mode expert. */
  simple: SimpleSchedule;
  /** État du mode expert : texte libre, éventuellement invalide. */
  cron: string;
  /**
   * Fuseau dans lequel l'expression sera interprétée par BullMQ. Porté par le
   * brouillon comme la cadence elle-même : les deux forment une heure, et une
   * heure sans fuseau ne veut rien dire.
   */
  timeZone: string;
};

const DEFAULT_SIMPLE: SimpleSchedule = { kind: 'daily', hour: 3, minute: 0 };

/** Cadence effective du brouillon, dans le format que la base stocke. */
export function draftCron(draft: ScheduleDraft): string {
  return draft.mode === 'simple' ? toCron(draft.simple) : draft.cron.trim();
}

/**
 * Corps de requête correspondant au brouillon.
 *
 * En mode simple on envoie la périodicité et c'est le **serveur** qui la
 * convertit : un client ne décide pas de ce qui est écrit en base, même quand
 * il sait calculer la même chose.
 */
export function draftBody(
  draft: ScheduleDraft,
): ({ schedule: SimpleSchedule } | { cron: string }) & { timezone: string } {
  const cadence =
    draft.mode === 'simple'
      ? { schedule: draft.simple }
      : { cron: draft.cron.trim() };
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

// ─── vocabulaire d'écran ──────────────────────────────────────────────────────

const KIND_LABELS: Record<SimpleScheduleKind, string> = {
  interval: 'Toutes les quelques minutes',
  hourly: 'Toutes les heures',
  daily: 'Tous les jours',
  weekly: 'Certains jours de la semaine',
  monthly: 'Une fois par mois',
};

/** Lundi en tête : c'est l'ordre attendu ici, pas celui de cron. */
const WEEKDAYS: ReadonlyArray<{ value: number; short: string; long: string }> = [
  { value: 1, short: 'L', long: 'lundi' },
  { value: 2, short: 'M', long: 'mardi' },
  { value: 3, short: 'M', long: 'mercredi' },
  { value: 4, short: 'J', long: 'jeudi' },
  { value: 5, short: 'V', long: 'vendredi' },
  { value: 6, short: 'S', long: 'samedi' },
  { value: 0, short: 'D', long: 'dimanche' },
];

const pad2 = (value: number): string => String(value).padStart(2, '0');

function hourAndMinuteOf(simple: SimpleSchedule): { hour: number; minute: number } {
  if (simple.kind === 'interval') return { hour: 3, minute: 0 };
  if (simple.kind === 'hourly') return { hour: 3, minute: simple.minute };
  return { hour: simple.hour, minute: simple.minute };
}

/** Changement de périodicité : on conserve l'heure déjà saisie. */
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

/** Quantifié : `getSnapshot` doit rendre la même valeur tant que rien ne bouge. */
function browserNow(): number {
  return Math.floor(Date.now() / TICK_MS) * TICK_MS;
}

function noNow(): null {
  return null;
}

/**
 * `null` côté serveur, et au premier rendu client.
 *
 * L'aperçu dépend de l'heure courante : le rendre pendant le SSR produirait un
 * texte que l'hydratation contredirait aussitôt. `useSyncExternalStore` donne
 * exactement ce contrat, sans `setState` dans un effet.
 */
function useNow(): number | null {
  return useSyncExternalStore(subscribeToTick, browserNow, noNow);
}

// ─── aperçu ───────────────────────────────────────────────────────────────────

function formatIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone,
  }).format(date);
}

function SchedulePreview({ cron, timeZone }: { cron: string; timeZone: string }) {
  const now = useNow();
  const error = cron.length === 0 ? 'cadence vide' : cronError(cron);

  const runs = useMemo(
    () => (error || now === null ? [] : nextRuns(cron, { from: new Date(now), count: 3, timeZone })),
    [cron, error, now, timeZone],
  );

  if (error) {
    return (
      <Alert variant="destructive" className="mt-1">
        Expression refusée : {error}. Rien ne sera planifié tant qu&apos;elle n&apos;est pas
        valide.
      </Alert>
    );
  }

  // Lu seulement une fois l'horloge disponible : côté serveur, le fuseau du
  // rendu n'est celui de personne.
  const viewerZone = now === null ? null : browserTimeZone();
  const differentZone = viewerZone !== null && viewerZone !== timeZone;

  return (
    <div className="mt-1 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs">
      <p className="text-ink">{describeCron(cron, { timeZone })}</p>
      <p className="mt-1 font-mono text-[0.6875rem] text-ink-faint">{cron}</p>

      <dl className="mt-2 space-y-0.5">
        {now === null ? (
          <div className="text-ink-faint">Prochaines exécutions : calcul en cours…</div>
        ) : runs.length === 0 ? (
          <div className="text-ink-faint">
            Aucune exécution dans les 366 prochains jours — vérifiez l&apos;expression.
          </div>
        ) : (
          runs.map((run, index) => (
            <div key={run.toISOString()} className="flex flex-wrap gap-x-2 text-ink-muted">
              <dt className="text-ink-faint">
                {index === 0 ? 'Prochaine' : `Puis (${index + 1})`}
              </dt>
              <dd className="font-mono tabular-nums">
                {formatIn(run, timeZone)} <span className="text-ink-faint">{timeZone}</span>
                {differentZone && viewerZone ? (
                  <span className="text-ink-faint">
                    {' · '}
                    {formatIn(run, viewerZone)} chez vous
                  </span>
                ) : null}
              </dd>
            </div>
          ))
        )}
      </dl>
    </div>
  );
}

// ─── champ ────────────────────────────────────────────────────────────────────

export function ScheduleField({
  idPrefix,
  value,
  onChange,
  timeZones,
  disabled = false,
}: {
  /** Préfixe d'identifiant : le champ apparaît deux fois sur la même page. */
  idPrefix: string;
  value: ScheduleDraft;
  onChange: (next: ScheduleDraft) => void;
  /**
   * Fuseaux proposés, énumérés **côté serveur** : c'est l'ICU du process qui
   * validera la saisie, proposer ceux du navigateur mènerait à des choix
   * refusés à l'enregistrement.
   */
  timeZones: readonly string[];
  disabled?: boolean;
}) {
  const cron = draftCron(value);
  const timeZone = value.timeZone;
  const expertHasSimpleForm = fromCron(value.cron.trim()) !== null;

  const setSimple = (simple: SimpleSchedule): void => onChange({ ...value, simple });

  const setMode = (mode: 'simple' | 'expert'): void => {
    if (mode === value.mode) return;
    if (mode === 'expert') {
      // On emporte la cadence en cours plutôt que de repartir d'un champ vide.
      onChange({ ...value, mode, cron: toCron(value.simple) });
      return;
    }
    // Si l'expression tapée a un équivalent simple, on l'adopte ; sinon on
    // garde la dernière périodicité simple choisie, et le cron est écrasé —
    // c'est ce que la mention sous le champ annonce.
    const parsed = fromCron(value.cron.trim());
    onChange({ ...value, mode, simple: parsed ?? value.simple });
  };

  const { simple } = value;
  const time = hourAndMinuteOf(simple);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor={`${idPrefix}-kind`}>Cadence</Label>
        <RadioGroup aria-label="Mode de saisie de la cadence">
          <RadioOption
            name={`${idPrefix}-mode`}
            label="Simple"
            value="simple"
            checked={value.mode === 'simple'}
            disabled={disabled}
            onChange={() => setMode('simple')}
          />
          <RadioOption
            name={`${idPrefix}-mode`}
            label="Expert"
            value="expert"
            checked={value.mode === 'expert'}
            disabled={disabled}
            onChange={() => setMode('expert')}
          />
        </RadioGroup>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={`${idPrefix}-tz`} className="text-xs font-normal text-ink-muted">
          Fuseau
        </Label>
        <Select
          id={`${idPrefix}-tz`}
          className="w-auto min-w-56"
          value={timeZone}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, timeZone: event.target.value })}
        >
          {/* Le fuseau enregistré peut avoir disparu de l'ICU courant : on le
              garde en tête de liste plutôt que de le remplacer en silence. */}
          {timeZones.includes(timeZone) ? null : (
            <option value={timeZone}>{timeZone} (inconnu de ce serveur)</option>
          )}
          {timeZones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </Select>
        {dependsOnTimeZone(value) ? null : (
          <span className="text-xs text-ink-faint">
            Cette cadence est un intervalle : elle ne dépend d&apos;aucun fuseau. Le réglage
            est conservé pour le jour où elle devient une heure fixe.
          </span>
        )}
      </div>

      {value.mode === 'simple' ? (
        <div className="flex flex-wrap items-end gap-2">
          <Select
            id={`${idPrefix}-kind`}
            className="w-auto min-w-56"
            value={simple.kind}
            disabled={disabled}
            onChange={(event) =>
              setSimple(withKind(simple, event.target.value as SimpleScheduleKind))
            }
          >
            {SIMPLE_SCHEDULE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABELS[kind]}
              </option>
            ))}
          </Select>

          {simple.kind === 'interval' ? (
            <Select
              aria-label="Intervalle en minutes"
              className="w-auto"
              value={String(simple.everyMinutes)}
              disabled={disabled}
              onChange={(event) =>
                setSimple({
                  kind: 'interval',
                  everyMinutes: Number(event.target.value) as (typeof SIMPLE_INTERVAL_MINUTES)[number],
                })
              }
            >
              {SIMPLE_INTERVAL_MINUTES.map((minutes) => (
                <option key={minutes} value={minutes}>
                  toutes les {minutes} min
                </option>
              ))}
            </Select>
          ) : null}

          {simple.kind === 'hourly' ? (
            <label className="flex items-center gap-2 text-xs text-ink-muted">
              à la minute
              <Input
                type="number"
                min={0}
                max={59}
                className="w-20 tabular-nums"
                value={simple.minute}
                disabled={disabled}
                onChange={(event) =>
                  setSimple({ kind: 'hourly', minute: clamp(event.target.value, 0, 59) })
                }
              />
            </label>
          ) : null}

          {simple.kind === 'monthly' ? (
            <label className="flex items-center gap-2 text-xs text-ink-muted">
              le
              <Input
                type="number"
                min={1}
                max={31}
                className="w-20 tabular-nums"
                value={simple.day}
                disabled={disabled}
                onChange={(event) =>
                  setSimple({ ...simple, day: clamp(event.target.value, 1, 31) })
                }
              />
            </label>
          ) : null}

          {simple.kind === 'weekly' ? (
            <div className="flex flex-wrap gap-1" role="group" aria-label="Jours de la semaine">
              {WEEKDAYS.map((day) => (
                <CheckboxChip
                  key={day.value}
                  label={day.short}
                  aria-label={day.long}
                  title={day.long}
                  checked={simple.weekdays.includes(day.value)}
                  // Un dernier jour décoché donnerait une semaine sans occurrence.
                  disabled={
                    disabled || (simple.weekdays.length === 1 && simple.weekdays[0] === day.value)
                  }
                  onChange={(event) => {
                    const weekdays = event.target.checked
                      ? [...simple.weekdays, day.value].sort((a, b) => a - b)
                      : simple.weekdays.filter((value) => value !== day.value);
                    if (weekdays.length > 0) setSimple({ ...simple, weekdays });
                  }}
                />
              ))}
            </div>
          ) : null}

          {simple.kind !== 'interval' && simple.kind !== 'hourly' ? (
            <label className="flex items-center gap-2 text-xs text-ink-muted">
              à
              <Input
                type="time"
                className="w-32 tabular-nums"
                value={`${pad2(time.hour)}:${pad2(time.minute)}`}
                disabled={disabled}
                onChange={(event) => {
                  const [hour, minute] = event.target.value.split(':');
                  if (hour === undefined || minute === undefined) return;
                  setSimple({ ...simple, hour: clamp(hour, 0, 23), minute: clamp(minute, 0, 59) });
                }}
              />
              <span className="text-ink-faint">{timeZone}</span>
            </label>
          ) : null}
        </div>
      ) : (
        <Input
          id={`${idPrefix}-cron`}
          aria-label="Expression cron"
          className="font-mono text-xs md:text-xs"
          placeholder="0 3 * * 1"
          value={value.cron}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, cron: event.target.value })}
        />
      )}

      {value.mode === 'expert' && !expertHasSimpleForm && cronError(value.cron.trim()) === null ? (
        <p className="text-xs text-ink-faint">
          Cette expression n&apos;a pas d&apos;équivalent en mode simple — plages, pas d&apos;heure
          ou listes de minutes n&apos;y sont pas représentables. Repasser en mode simple la
          remplacerait.
        </p>
      ) : null}

      {simple.kind === 'monthly' && value.mode === 'simple' && simple.day > 28 ? (
        <p className="text-xs text-warn">
          Le {simple.day} n&apos;existe pas tous les mois : ceux qui sont plus courts sont
          simplement sautés.
        </p>
      ) : null}

      <SchedulePreview cron={cron} timeZone={timeZone} />
    </div>
  );
}

/**
 * Une cadence dont l'heure est fixée dépend du fuseau ; un intervalle en
 * minutes, non — le dire évite de laisser croire à un réglage sans effet.
 */
function dependsOnTimeZone(draft: ScheduleDraft): boolean {
  const simple = fromCron(draftCron(draft));
  if (!simple) return true;
  return simple.kind !== 'interval' && simple.kind !== 'hourly';
}

function clamp(raw: string | number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
