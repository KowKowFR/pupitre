'use client';

import { fromWallClockInput, toWallClockInput, type Translate } from '@pupitre/core';
import { Megaphone, Plus, Wrench } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { EmptyState } from '@/components/empty-state';
import { Led, type Tone } from '@/components/instrument';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CheckboxField } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { KeyValue } from '@/components/ui/data';
import {
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerSection,
  useDrawerSelection,
} from '@/components/ui/drawer';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { maintenance as messages } from '@/i18n/messages/maintenance';
import type { FormatSettings } from '@/lib/format';
import type { HeldAlertJson, MaintenanceWindowJson } from '@/lib/maintenance';
import { maintenanceWhen } from '@/lib/maintenance-format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

type Option = { id: string; name: string; detail: string | null };

const PHASE_TONE: Record<MaintenanceWindowJson['phase'], Tone> = {
  active: 'warn',
  upcoming: 'accent',
  ended: 'idle',
};

const DURATIONS: ReadonlyArray<{ label: string; minutes: number }> = [
  { label: '30 min', minutes: 30 },
  { label: '1 h', minutes: 60 },
  { label: '2 h', minutes: 120 },
  { label: '4 h', minutes: 240 },
];

const when = maintenanceWhen;

/** "1 h 30", "45 min", "2 d 3 h", "less than a minute". */
function duration(startsAt: string, endsAt: string, t: Translate<typeof messages.fr>): string {
  const minutes = Math.floor((new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0)
    return hours > 0 ? t('duration.daysHours', { days, hours }) : t('duration.days', { days });
  if (hours > 0) {
    return rest > 0
      ? t('duration.hoursMinutes', { hours, minutes: String(rest).padStart(2, '0') })
      : t('duration.hours', { hours });
  }
  return minutes > 0 ? t('duration.minutes', { minutes }) : t('duration.lessThanMinute');
}

async function failure(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
  return body.error?.message ?? fallback;
}

/** The header's button: it opens the scheduling drawer (`?new=1`). */
export function NewMaintenanceButton() {
  const t = useT(messages);
  const adding = useDrawerSelection('new');
  return (
    <Button onClick={() => adding.open('1')}>
      <Plus aria-hidden />
      {t('action.new')}
    </Button>
  );
}

export function MaintenanceView({
  windows,
  format,
  canManage,
  canAnnounce = false,
  targets,
  monitors,
}: {
  windows: MaintenanceWindowJson[];
  format: FormatSettings;
  canManage: boolean;
  /** Publishing an announcement on the status pages: the drawer leads there. */
  canAnnounce?: boolean;
  targets: Option[];
  monitors: Option[];
}) {
  const t = useT(messages);
  const router = useRouter();
  const searchParams = useSearchParams();
  const detail = useDrawerSelection(
    'window',
    windows.map((window) => window.id),
  );
  const adding = useDrawerSelection('new');
  const current = windows.find((window) => window.id === detail.selected) ?? null;

  const groups = (['active', 'upcoming', 'ended'] as const)
    .map((phase) => ({ phase, items: windows.filter((window) => window.phase === phase) }))
    .filter((group) => group.items.length > 0);

  // A "Put under maintenance" link from a target or a probe arrives with its
  // subject: the form starts from there.
  const prefill = {
    targetIds: [searchParams.get('target')].filter((id): id is string =>
      targets.some((target) => target.id === id),
    ),
    monitorIds: [searchParams.get('monitor')].filter((id): id is string =>
      monitors.some((monitor) => monitor.id === id),
    ),
  };

  function created(window: MaintenanceWindowJson) {
    adding.close();
    detail.open(window.id);
    router.refresh();
  }

  return (
    <>
      {groups.length === 0 ? (
        <EmptyState
          icon={Wrench}
          title={t('empty.title')}
          hint={t('empty.hint')}
          action={canManage ? <NewMaintenanceButton /> : undefined}
        />
      ) : (
        groups.map((group) => (
          <section
            key={group.phase}
            className="card overflow-hidden"
            aria-labelledby={`maintenance-${group.phase}`}
          >
            <div className="card-h">
              <h2 id={`maintenance-${group.phase}`}>{t(`section.${group.phase}`)}</h2>
              <span className="t-cap ml-auto text-text-3">{group.items.length}</span>
            </div>
            <ul className="list is-link">
              {group.items.map((window) => (
                <MaintenanceRow
                  key={window.id}
                  window={window}
                  format={format}
                  selected={window.id === detail.selected}
                  onOpen={() => detail.open(window.id)}
                />
              ))}
            </ul>
          </section>
        ))
      )}

      <Drawer
        open={current !== null}
        onOpenChange={(open) => (open ? undefined : detail.close())}
        onPrevious={detail.onPrevious}
        onNext={detail.onNext}
        wide
        label={current?.title}
      >
        {current ? (
          <MaintenanceDrawer
            key={current.id}
            window={current}
            format={format}
            canManage={canManage}
            canAnnounce={canAnnounce}
            targets={targets}
            monitors={monitors}
            onClosed={() => {
              detail.close();
              router.refresh();
            }}
            onChanged={() => router.refresh()}
          />
        ) : null}
      </Drawer>

      <Drawer
        open={canManage && adding.selected !== null}
        onOpenChange={(open) => (open ? undefined : adding.close())}
        wide
        label={t('form.title.new')}
      >
        {canManage && adding.selected !== null ? (
          <MaintenanceForm
            key={`${prefill.targetIds.join()}|${prefill.monitorIds.join()}`}
            format={format}
            targets={targets}
            monitors={monitors}
            prefill={prefill}
            onSaved={created}
            onCancel={() => adding.close()}
          />
        ) : null}
      </Drawer>
    </>
  );
}

function MaintenanceRow({
  window,
  format,
  selected,
  onOpen,
}: {
  window: MaintenanceWindowJson;
  format: FormatSettings;
  selected: boolean;
  onOpen: () => void;
}) {
  const t = useT(messages);
  const subjects = [...window.targets, ...window.monitors].map((subject) => subject.name);
  const timing =
    window.phase === 'active'
      ? t('row.until', { time: when(window.endsAt, format) })
      : window.phase === 'upcoming'
        ? t('row.from', { date: when(window.startsAt, format) })
        : t('row.ended', { date: when(window.endsAt, format) });
  return (
    <li className={cn('relative flex-wrap gap-y-1 sm:flex-nowrap', selected && 'is-selected')}>
      <span className="flex w-3.5 justify-center">
        <Led tone={PHASE_TONE[window.phase]} pulse={window.phase === 'active'} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <button
          type="button"
          className="text-left font-medium text-text after:absolute after:inset-0"
          aria-label={t('row.open', { title: window.title })}
          onClick={onOpen}
        >
          {window.title}
        </button>
        <span className="mono t-cap truncate text-text-2">
          {subjects.join(' · ')}
          {window.hiddenSubjects > 0
            ? `${subjects.length > 0 ? ' ' : ''}${t('row.hidden', { count: window.hiddenSubjects })}`
            : ''}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5 text-right max-sm:basis-full max-sm:items-start max-sm:pl-[26px]">
        <span className="t-sm text-text-2">{timing}</span>
        {window.phase !== 'upcoming' ? (
          <span className="t-cap text-text-3">
            {t('row.held', { count: window.held })}
            {window.released > 0 ? ` · ${t('row.released', { count: window.released })}` : ''}
          </span>
        ) : null}
      </span>
    </li>
  );
}

function MaintenanceDrawer({
  window,
  format,
  canManage,
  canAnnounce,
  targets,
  monitors,
  onClosed,
  onChanged,
}: {
  window: MaintenanceWindowJson;
  format: FormatSettings;
  canManage: boolean;
  canAnnounce: boolean;
  targets: Option[];
  monitors: Option[];
  onClosed: () => void;
  onChanged: () => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const [editing, setEditing] = React.useState(false);
  const [confirm, setConfirm] = React.useState<'end' | 'delete' | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (editing) {
    return (
      <MaintenanceForm
        initial={window}
        format={format}
        targets={targets}
        monitors={monitors}
        onSaved={() => {
          setEditing(false);
          onChanged();
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  async function act() {
    if (!confirm) return;
    setPending(true);
    setError(null);
    const response =
      confirm === 'end'
        ? await fetch(`/api/maintenance-windows/${window.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ endsAt: new Date().toISOString() }),
          })
        : await fetch(`/api/maintenance-windows/${window.id}`, { method: 'DELETE' });
    setPending(false);
    if (!response.ok) {
      setError(await failure(response, tc('http.failure', { status: response.status })));
      return;
    }
    if (confirm === 'end') {
      toast({
        title: t('toast.ended', { title: window.title }),
        description: t('toast.ended.detail'),
        tone: 'ok',
      });
      setConfirm(null);
      onChanged();
    } else {
      toast({ title: t('toast.deleted', { title: window.title }), tone: 'ok' });
      setConfirm(null);
      onClosed();
    }
  }

  return (
    <>
      <DrawerHeader
        icon={<Wrench aria-hidden />}
        kind={t('drawer.kind')}
        title={window.title}
        state={
          <Badge
            variant={
              window.phase === 'active' ? 'warn' : window.phase === 'upcoming' ? 'accent' : 'idle'
            }
            dot
          >
            {t(`phase.${window.phase}`)}
          </Badge>
        }
      />
      <DrawerBody>
        <DrawerSection title={t('drawer.period')}>
          <KeyValue
            items={[
              { term: t('drawer.starts'), value: when(window.startsAt, format) },
              { term: t('drawer.ends'), value: when(window.endsAt, format) },
              { term: t('drawer.duration'), value: duration(window.startsAt, window.endsAt, t) },
            ]}
          />
        </DrawerSection>

        <DrawerSection title={t('drawer.covers')}>
          <div className="flex flex-col gap-2.5">
            {window.targets.length > 0 ? (
              <SubjectLinks
                label={t('drawer.covers.targets')}
                items={window.targets.map((target) => ({
                  ...target,
                  href: `/targets?target=${target.id}`,
                }))}
              />
            ) : null}
            {window.monitors.length > 0 ? (
              <SubjectLinks
                label={t('drawer.covers.monitors')}
                items={window.monitors.map((monitor) => ({
                  ...monitor,
                  href: `/monitors?monitor=${monitor.id}`,
                }))}
              />
            ) : null}
            {window.targets.length > 0 ? (
              <p className="t-cap text-text-3">{t('drawer.covers.derived')}</p>
            ) : null}
            {window.hiddenSubjects > 0 ? (
              <p className="t-cap text-text-3">
                {t('drawer.covers.hidden', { count: window.hiddenSubjects })}
              </p>
            ) : null}
          </div>
        </DrawerSection>

        {window.note ? (
          <DrawerSection title={t('drawer.note')}>
            <p className="t-sm whitespace-pre-line text-text-2">{window.note}</p>
          </DrawerSection>
        ) : null}

        {canAnnounce ? (
          <Link
            href={`/status-pages?announce=maintenance:${window.id}`}
            className="link t-sm inline-flex items-center gap-1.5 self-start"
          >
            <Megaphone aria-hidden className="size-4" />
            {t('drawer.announce')}
          </Link>
        ) : null}

        <DrawerSection title={t('drawer.held')}>
          <HeldAlerts window={window} format={format} />
        </DrawerSection>
      </DrawerBody>

      {canManage ? (
        <DrawerFooter
          end={
            window.phase !== 'active' ? (
              <Button variant="ghost" onClick={() => setConfirm('delete')}>
                {t('action.delete')}
              </Button>
            ) : undefined
          }
        >
          {window.phase === 'active' ? (
            <Button onClick={() => setConfirm('end')}>{t('action.end')}</Button>
          ) : null}
          {window.phase !== 'ended' ? (
            <Button
              variant={window.phase === 'active' ? 'secondary' : 'default'}
              onClick={() => setEditing(true)}
            >
              {t('action.edit')}
            </Button>
          ) : null}
        </DrawerFooter>
      ) : null}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => (open ? undefined : setConfirm(null))}
        level={confirm === 'delete' ? 'trace' : 'reversible'}
        title={
          confirm === 'end'
            ? t('confirm.end.title', { title: window.title })
            : t('confirm.delete.title', { title: window.title })
        }
        consequences={
          confirm === 'end'
            ? [t('confirm.end.consequence.alerts'), t('confirm.end.consequence.release')]
            : [
                window.phase === 'upcoming'
                  ? t('confirm.delete.upcoming')
                  : t('confirm.delete.ended'),
              ]
        }
        confirmLabel={confirm === 'end' ? t('confirm.end.action') : t('confirm.delete.action')}
        pending={pending}
        error={error}
        onConfirm={act}
      />
    </>
  );
}

function SubjectLinks({
  label,
  items,
}: {
  label: string;
  items: Array<{ id: string; name: string; href: string }>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="t-cap w-16 shrink-0 text-text-3">{label}</span>
      {items.map((item) => (
        <Link
          key={item.id}
          href={item.href as never}
          className="badge b-outline mono hover:underline"
        >
          {item.name}
        </Link>
      ))}
    </div>
  );
}

/** The held alerts, read when the drawer opens — there can be many of them. */
function HeldAlerts({ window, format }: { window: MaintenanceWindowJson; format: FormatSettings }) {
  const t = useT(messages);
  const [state, setState] = React.useState<HeldAlertJson[] | 'loading' | 'error'>('loading');

  React.useEffect(() => {
    let alive = true;
    fetch(`/api/maintenance-windows/${window.id}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error())))
      .then((body: { heldAlerts: HeldAlertJson[] }) => {
        if (alive) setState(body.heldAlerts);
      })
      .catch(() => {
        if (alive) setState('error');
      });
    return () => {
      alive = false;
    };
  }, [window.id, window.held, window.released, window.phase]);

  if (state === 'loading') return <p className="t-sm text-text-3">{t('drawer.held.loading')}</p>;
  if (state === 'error')
    return <p className="t-sm text-danger-text">{t('drawer.held.unreadable')}</p>;
  return (
    <div className="flex flex-col gap-2">
      <p className="t-cap text-text-3">{t('drawer.held.explain')}</p>
      {state.length === 0 ? (
        <p className="t-sm text-text-2">{t('drawer.held.none')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {state.map((alert) => {
            const status = alert.releasedAt
              ? 'released'
              : window.phase === 'ended'
                ? 'dropped'
                : 'held';
            return (
              <li key={alert.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <span className="t-sm min-w-0 flex-1 text-text">{alert.label}</span>
                <span className="t-cap text-text-3">{when(alert.heldAt, format)}</span>
                <Badge
                  variant={status === 'released' ? 'warn' : status === 'held' ? 'accent' : 'idle'}
                >
                  {t(`drawer.held.state.${status}`)}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** One checkbox per subject, with a filter when the list is long. */
function SubjectPicker({
  label,
  help,
  empty,
  options,
  selected,
  onToggle,
}: {
  label: string;
  help?: string;
  empty: string;
  options: Option[];
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  const t = useT(messages);
  const [filter, setFilter] = React.useState('');
  const shown = options.filter((option) =>
    `${option.name} ${option.detail ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="t-sm mb-1 flex w-full items-center font-medium text-text">
        {label}
        <span className="t-cap ml-auto font-normal text-text-3">
          {t('form.selected', { count: selected.size })}
        </span>
      </legend>
      {help ? <p className="t-cap -mt-1 text-text-3">{help}</p> : null}
      {options.length === 0 ? (
        <p className="t-sm text-text-3">{empty}</p>
      ) : (
        <>
          {options.length > 8 ? (
            <Input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t('form.filter')}
              aria-label={`${label} — ${t('form.filter')}`}
            />
          ) : null}
          <div className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-lg border border-border p-2">
            {shown.map((option) => (
              <CheckboxField
                key={option.id}
                label={
                  <span className="flex items-baseline gap-2">
                    <span className="mono">{option.name}</span>
                    {option.detail ? (
                      <span className="t-cap text-text-3">{option.detail}</span>
                    ) : null}
                  </span>
                }
                checked={selected.has(option.id)}
                onChange={() => onToggle(option.id)}
              />
            ))}
          </div>
        </>
      )}
    </fieldset>
  );
}

/**
 * The current minute: the input has no seconds, and "put under maintenance"
 * means now — rounding to the next minute would make a window "upcoming" for a
 * few seconds, and an alert from those seconds would go out.
 */
function currentMinute(): Date {
  return new Date(Math.floor(Date.now() / 60_000) * 60_000);
}

function MaintenanceForm({
  initial,
  format,
  targets,
  monitors,
  prefill,
  onSaved,
  onCancel,
}: {
  initial?: MaintenanceWindowJson;
  format: FormatSettings;
  targets: Option[];
  monitors: Option[];
  prefill?: { targetIds: string[]; monitorIds: string[] };
  onSaved: (window: MaintenanceWindowJson) => void;
  onCancel: () => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const zone = format.timezone;
  const [title, setTitle] = React.useState(initial?.title ?? '');
  const [note, setNote] = React.useState(initial?.note ?? '');
  const [starts, setStarts] = React.useState(() =>
    toWallClockInput(initial?.startsAt ?? currentMinute(), zone),
  );
  const [ends, setEnds] = React.useState(() =>
    toWallClockInput(initial?.endsAt ?? new Date(currentMinute().getTime() + 3_600_000), zone),
  );
  const [targetIds, setTargetIds] = React.useState<Set<string>>(
    () => new Set(initial?.targets.map((target) => target.id) ?? prefill?.targetIds ?? []),
  );
  const [monitorIds, setMonitorIds] = React.useState<Set<string>>(
    () => new Set(initial?.monitors.map((monitor) => monitor.id) ?? prefill?.monitorIds ?? []),
  );
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const startsAt = fromWallClockInput(starts, zone);
  const endsAt = fromWallClockInput(ends, zone);
  const datesError =
    startsAt === null || endsAt === null
      ? t('form.error.unreadable')
      : new Date(endsAt) <= new Date(startsAt)
        ? t('form.error.dates')
        : null;
  const subjectsError =
    targetIds.size + monitorIds.size + (initial?.hiddenSubjects ?? 0) === 0
      ? t('form.error.subjects')
      : null;

  function toggle(set: Set<string>, update: (next: Set<string>) => void, id: string) {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    update(next);
  }

  function setDuration(minutes: number) {
    const start = fromWallClockInput(starts, zone);
    if (!start) return;
    setEnds(toWallClockInput(new Date(new Date(start).getTime() + minutes * 60_000), zone));
  }

  const sameSet = (a: ReadonlySet<string>, b: readonly string[]) =>
    a.size === b.length && b.every((id) => a.has(id));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (datesError || subjectsError || !startsAt || !endsAt) return;
    setPending(true);
    setError(null);
    // When editing, the subjects only go out if they changed: a probe the session
    // does not see is not removed because it is not checked.
    const body = {
      title,
      note: note.trim() === '' ? null : note,
      startsAt,
      endsAt,
      ...(!initial ||
      !sameSet(
        targetIds,
        initial.targets.map((target) => target.id),
      )
        ? { targetIds: [...targetIds] }
        : {}),
      ...(!initial ||
      !sameSet(
        monitorIds,
        initial.monitors.map((monitor) => monitor.id),
      )
        ? { monitorIds: [...monitorIds] }
        : {}),
    };
    const response = await fetch(
      initial ? `/api/maintenance-windows/${initial.id}` : '/api/maintenance-windows',
      {
        method: initial ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    setPending(false);
    if (!response.ok) {
      setError(await failure(response, tc('http.failure', { status: response.status })));
      return;
    }
    const saved = (await response.json()) as MaintenanceWindowJson;
    toast({
      title: t(initial ? 'toast.updated' : 'toast.created', { title: saved.title }),
      tone: 'ok',
    });
    onSaved(saved);
  }

  return (
    <form onSubmit={submit} className="contents" noValidate>
      <DrawerHeader
        icon={<Wrench aria-hidden />}
        kind={t('drawer.kind')}
        title={initial ? t('form.title.edit') : t('form.title.new')}
      />
      <DrawerBody>
        <Field label={t('form.field.title')}>
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t('form.field.title.placeholder')}
            maxLength={120}
            required
          />
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label={t('form.field.starts')}
            error={startsAt === null ? t('form.error.unreadable') : undefined}
          >
            <Input
              type="datetime-local"
              value={starts}
              onChange={(event) => setStarts(event.target.value)}
            />
          </Field>
          <Field
            label={t('form.field.ends')}
            error={startsAt !== null ? (datesError ?? undefined) : undefined}
          >
            <Input
              type="datetime-local"
              value={ends}
              onChange={(event) => setEnds(event.target.value)}
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {!initial || initial.phase === 'upcoming' ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setStarts(toWallClockInput(new Date(), zone))}
            >
              {t('form.now')}
            </Button>
          ) : null}
          <span className="t-cap ml-1 text-text-3">{t('form.durations')}</span>
          {DURATIONS.map((option) => (
            <Button
              key={option.minutes}
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => setDuration(option.minutes)}
            >
              {option.label}
            </Button>
          ))}
        </div>
        <p className="t-cap -mt-1 text-text-3">{t('form.timezone', { zone })}</p>

        <SubjectPicker
          label={t('form.field.targets')}
          empty={t('form.none.targets')}
          options={targets}
          selected={targetIds}
          onToggle={(id) => toggle(targetIds, setTargetIds, id)}
        />
        <SubjectPicker
          label={t('form.field.monitors')}
          help={t('form.field.monitors.help')}
          empty={t('form.none.monitors')}
          options={monitors}
          selected={monitorIds}
          onToggle={(id) => toggle(monitorIds, setMonitorIds, id)}
        />
        {subjectsError ? <p className="t-sm text-danger-text">{subjectsError}</p> : null}

        <Field label={t('form.field.note')} help={t('form.field.note.help')} optional>
          <Textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            maxLength={1000}
          />
        </Field>

        {error ? (
          <p role="alert" className="t-sm text-danger-text">
            {error}
          </p>
        ) : null}
      </DrawerBody>
      <DrawerFooter>
        <Button
          type="submit"
          loading={pending}
          disabled={title.trim() === '' || datesError !== null || subjectsError !== null}
        >
          {initial ? t('form.submit.edit') : t('form.submit.new')}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('form.cancel')}
        </Button>
      </DrawerFooter>
    </form>
  );
}
