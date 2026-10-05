'use client';

import {
  STATUS_UPDATE_MESSAGE_MAX,
  statusUpdatePhasesFor,
  suggestedStatusUpdatePhase,
  type StatusUpdatePhase,
  type Translate,
} from '@pupitre/core';
import { Megaphone, Pencil, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { HelpCallout } from '@/components/help-drawer';
import { Led, type Tone } from '@/components/instrument';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerSection,
  useDrawerSelection,
} from '@/components/ui/drawer';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { statusPages as messages } from '@/i18n/messages/status-pages';
import { formatDateTimeWith, type FormatSettings } from '@/lib/format';
import type { AnnounceSubjectJson, StatusUpdateJson } from '@/lib/status-updates';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

type T = Translate<typeof messages.fr>;

async function failure(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
  return body.error?.message ?? fallback;
}

/** A phase's tone: an outage being investigated, held, resolved. */
const PHASE_BADGE: Record<StatusUpdatePhase, 'danger' | 'warn' | 'accent' | 'ok' | 'idle'> = {
  investigating: 'danger',
  identified: 'warn',
  monitoring: 'accent',
  resolved: 'ok',
  scheduled: 'idle',
  in_progress: 'accent',
  completed: 'ok',
};

function subjectTone(subject: AnnounceSubjectJson): Tone {
  if (subject.state === 'ended') return 'idle';
  return subject.type === 'incident' ? 'danger' : 'accent';
}

function whenOf(format: FormatSettings) {
  return (value: string) =>
    formatDateTimeWith(value, format, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: format.timezone,
    });
}

function timing(subject: AnnounceSubjectJson, t: T, when: (value: string) => string): string {
  if (subject.type === 'incident') {
    return subject.endsAt
      ? t('announce.incident.resolved', {
          start: when(subject.startsAt),
          end: when(subject.endsAt),
        })
      : t('announce.incident.ongoing', { start: when(subject.startsAt) });
  }
  const end = subject.endsAt ?? subject.startsAt;
  if (subject.state === 'ongoing') return t('announce.maintenance.active', { end: when(end) });
  if (subject.state === 'upcoming') {
    return t('announce.maintenance.upcoming', { start: when(subject.startsAt), end: when(end) });
  }
  return t('announce.maintenance.ended', { start: when(subject.startsAt), end: when(end) });
}

/**
 * The announcements: the outages and maintenance windows of your pages' probes,
 * and for each one a drawer (`?annonce=incident:<id>`) where to publish what the
 * visitors will read.
 */
export function Announcements({
  subjects,
  format,
}: {
  subjects: AnnounceSubjectJson[];
  format: FormatSettings;
}) {
  const t = useT(messages);
  const router = useRouter();
  const when = whenOf(format);
  const drawer = useDrawerSelection(
    'annonce',
    subjects.map((subject) => subject.key),
  );
  const current = subjects.find((subject) => subject.key === drawer.selected) ?? null;

  return (
    <>
      <section className="card overflow-hidden">
        <div className="card-h">
          <h2>{t('announce.title')}</h2>
          <span className="sub">{t('announce.sub')}</span>
        </div>
        {subjects.length === 0 ? (
          <p className="t-sm px-4 py-3.5 text-text-2">{t('announce.empty')}</p>
        ) : (
          <ul className="list is-link">
            {subjects.map((subject) => {
              const latest = subject.updates.at(-1);
              return (
                <li
                  key={subject.key}
                  className={cn(
                    'relative flex-wrap gap-y-1 sm:flex-nowrap',
                    subject.key === drawer.selected && 'is-selected',
                  )}
                >
                  <Led tone={subjectTone(subject)} pulse={subject.state === 'ongoing'} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <button
                      type="button"
                      className="text-left font-medium text-text after:absolute after:inset-0"
                      aria-label={t('announce.row', { title: subject.title })}
                      onClick={() => drawer.open(subject.key)}
                    >
                      {subject.title}
                    </button>
                    <span className="t-cap text-text-2">
                      {t(`announce.${subject.type}`)} · {timing(subject, t, when)}
                      {subject.seenAs.length > 0
                        ? ` · ${t('announce.seenAs', { names: subject.seenAs.join(', ') })}`
                        : ''}
                    </span>
                  </span>
                  {latest ? (
                    <Badge variant={PHASE_BADGE[latest.phase]} dot>
                      {t(`phase.${latest.phase}`)}
                    </Badge>
                  ) : null}
                  <span className="t-cap shrink-0 text-text-3">
                    {t('announce.count', { count: subject.updates.length })}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Drawer
        open={current !== null}
        onOpenChange={(open) => (open ? undefined : drawer.close())}
        wide
        label={current?.title ?? t('announce.kind')}
      >
        {current ? (
          <AnnounceDrawer
            key={current.key}
            subject={current}
            format={format}
            onChanged={() => router.refresh()}
            onClose={() => drawer.close()}
          />
        ) : null}
      </Drawer>
    </>
  );
}

function AnnounceDrawer({
  subject,
  format,
  onChanged,
  onClose,
}: {
  subject: AnnounceSubjectJson;
  format: FormatSettings;
  onChanged: () => void;
  onClose: () => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const when = whenOf(format);
  const phases = statusUpdatePhasesFor(subject.type);
  const latest = subject.updates.at(-1) ?? null;
  const [phase, setPhase] = React.useState<StatusUpdatePhase>(() =>
    suggestedStatusUpdatePhase(subject.type, latest?.phase ?? null),
  );
  const [message, setMessage] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function publish() {
    setPending(true);
    setError(null);
    const response = await fetch('/api/status-updates', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: { type: subject.type, id: subject.id }, phase, message }),
    });
    setPending(false);
    if (!response.ok) {
      setError(await failure(response, tc('http.failure', { status: response.status })));
      return;
    }
    setMessage('');
    toast({ title: t('toast.announced'), tone: 'ok' });
    onChanged();
  }

  const phaseOptions = phases.map((value) => ({ value, label: t(`phase.${value}`) }));

  return (
    <>
      <DrawerHeader
        icon={<Megaphone aria-hidden />}
        kind={`${t('announce.kind')} · ${t(`announce.${subject.type}`)}`}
        title={subject.title}
        state={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 t-sm text-text-2">
            <Led tone={subjectTone(subject)} pulse={subject.state === 'ongoing'} />
            {timing(subject, t, when)}
            {subject.seenAs.length > 0 ? (
              <span className="text-text-3">
                · {t('announce.seenAs', { names: subject.seenAs.join(', ') })}
              </span>
            ) : null}
          </span>
        }
      />
      <DrawerBody>
        <div className="flex flex-col gap-5">
          {subject.onPage ? null : (
            <HelpCallout tone="warn">
              {subject.type === 'incident'
                ? t('announce.offPage')
                : t('announce.offPage.maintenance')}
            </HelpCallout>
          )}

          <DrawerSection title={t('announce.compose')}>
            <div className="flex flex-col gap-3">
              <Field label={t('announce.field.phase')}>
                <SegmentedControl
                  value={phase}
                  onChange={setPhase}
                  options={phaseOptions}
                  label={t('announce.field.phase')}
                />
              </Field>
              <Field label={t('announce.field.message')} help={t('announce.field.message.help')}>
                <Textarea
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  rows={4}
                  maxLength={STATUS_UPDATE_MESSAGE_MAX}
                  placeholder={t('announce.field.message.placeholder')}
                />
              </Field>
              {phase === 'resolved' ? (
                <p className="t-cap text-text-3">{t('announce.resolvedNote')}</p>
              ) : null}
              {error ? (
                <p role="alert" className="t-sm text-danger-text">
                  {error}
                </p>
              ) : null}
            </div>
          </DrawerSection>

          <DrawerSection title={t('announce.timeline')}>
            {subject.updates.length === 0 ? (
              <p className="t-sm text-text-2">{t('announce.timeline.empty')}</p>
            ) : (
              <ol className="flex flex-col gap-3 border-l-2 border-border pl-3">
                {[...subject.updates].reverse().map((update) => (
                  <PublishedUpdate
                    key={update.id}
                    update={update}
                    phases={phases}
                    when={when}
                    onChanged={onChanged}
                  />
                ))}
              </ol>
            )}
          </DrawerSection>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button loading={pending} disabled={message.trim() === ''} onClick={publish}>
          <Megaphone aria-hidden />
          {t('announce.publish')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('editor.cancel')}
        </Button>
      </DrawerFooter>
    </>
  );
}

/** An already published announcement: one reads it, corrects it, removes it. */
function PublishedUpdate({
  update,
  phases,
  when,
  onChanged,
}: {
  update: StatusUpdateJson;
  phases: readonly StatusUpdatePhase[];
  when: (value: string) => string;
  onChanged: () => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const [editing, setEditing] = React.useState(false);
  const [phase, setPhase] = React.useState(update.phase);
  const [message, setMessage] = React.useState(update.message);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState(false);
  const [removePending, setRemovePending] = React.useState(false);
  const [removeError, setRemoveError] = React.useState<string | null>(null);

  async function save() {
    setPending(true);
    setError(null);
    const response = await fetch(`/api/status-updates/${update.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phase, message }),
    });
    setPending(false);
    if (!response.ok) {
      setError(await failure(response, tc('http.failure', { status: response.status })));
      return;
    }
    setEditing(false);
    toast({ title: t('toast.announceSaved'), tone: 'ok' });
    onChanged();
  }

  async function remove() {
    setRemovePending(true);
    setRemoveError(null);
    const response = await fetch(`/api/status-updates/${update.id}`, { method: 'DELETE' });
    setRemovePending(false);
    if (!response.ok) {
      setRemoveError(await failure(response, tc('http.failure', { status: response.status })));
      return;
    }
    setRemoving(false);
    toast({ title: t('toast.announceRemoved'), tone: 'ok' });
    onChanged();
  }

  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={PHASE_BADGE[update.phase]} dot>
          {t(`phase.${update.phase}`)}
        </Badge>
        <span className="t-cap text-text-3">
          {when(update.createdAt)}
          {update.authorName ? ` · ${t('announce.by', { name: update.authorName })}` : ''}
          {update.edited ? ` · ${t('announce.edited')}` : ''}
        </span>
        {editing ? null : (
          <span className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              <Pencil aria-hidden />
              {t('announce.edit')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setRemoving(true)}>
              <Trash2 aria-hidden />
              {t('announce.remove')}
            </Button>
          </span>
        )}
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <SegmentedControl
            value={phase}
            onChange={setPhase}
            options={phases.map((value) => ({ value, label: t(`phase.${value}`) }))}
            label={t('announce.field.phase')}
          />
          <Textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            rows={3}
            maxLength={STATUS_UPDATE_MESSAGE_MAX}
            aria-label={t('announce.field.message')}
          />
          {error ? (
            <p role="alert" className="t-sm text-danger-text">
              {error}
            </p>
          ) : null}
          <span className="flex gap-2">
            <Button size="sm" loading={pending} disabled={message.trim() === ''} onClick={save}>
              {t('announce.edit.save')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setPhase(update.phase);
                setMessage(update.message);
                setError(null);
              }}
            >
              {t('editor.cancel')}
            </Button>
          </span>
        </div>
      ) : (
        <p className="t-sm whitespace-pre-line text-text">{update.message}</p>
      )}
      <ConfirmDialog
        open={removing}
        onOpenChange={(open) => (open ? undefined : setRemoving(false))}
        level="trace"
        title={t('announce.confirm.title')}
        consequences={[t('announce.confirm.consequence')]}
        confirmLabel={t('announce.confirm.action')}
        pending={removePending}
        error={removeError}
        onConfirm={remove}
      />
    </li>
  );
}
