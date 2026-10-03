'use client';

import {
  STATUS_BLOCK_TYPES,
  STATUS_PAGE_INCIDENT_DAYS,
  statusPagePath,
  type StatusBlock,
  type StatusBlockType,
  type Translate,
} from '@pupitre/core';
import {
  ArrowDown,
  ArrowUp,
  ExternalLink,
  GripVertical,
  Plus,
  RadioTower,
  Trash2,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { EmptyState } from '@/components/empty-state';
import { StatusPageView } from '@/components/status/status-page-view';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SwitchField } from '@/components/ui/switch';
import { IconButton } from '@/components/ui/tooltip';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { statusPages as messages } from '@/i18n/messages/status-pages';
import type { FormatSettings } from '@/lib/format';
import type { StatusPageJson, StatusPageModel } from '@/lib/status-page';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

type MonitorOption = { id: string; name: string };
type T = Translate<typeof messages.fr>;

const NEW = 'nouvelle';

async function failure(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
  return body.error?.message ?? fallback;
}

function newId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** Un bloc neuf de ce type, prêt à être réglé. */
function blankBlock(type: StatusBlockType): StatusBlock {
  const id = newId();
  switch (type) {
    case 'summary':
      return { id, type };
    case 'heading':
      return { id, type, text: '' };
    case 'text':
      return { id, type, text: '' };
    case 'services':
      return { id, type, title: null, items: [], history: true, uptime: true };
    case 'maintenance':
      return { id, type };
    case 'incidents':
      return { id, type, days: 14 };
  }
}

/** Un bloc qu'on ne peut pas encore envoyer : un texte vide, un groupe sans sonde. */
function incomplete(block: StatusBlock): boolean {
  if (block.type === 'heading' || block.type === 'text') return block.text.trim() === '';
  if (block.type === 'services') return block.items.length === 0;
  return false;
}

export function NewStatusPageButton() {
  const t = useT(messages);
  const editor = useDrawerSelection('page');
  return (
    <Button onClick={() => editor.open(NEW)}>
      <Plus aria-hidden />
      {t('action.new')}
    </Button>
  );
}

export function StatusPagesView({
  pages,
  monitors,
  format,
}: {
  pages: StatusPageJson[];
  monitors: MonitorOption[];
  format: FormatSettings;
}) {
  const t = useT(messages);
  const router = useRouter();
  const editor = useDrawerSelection(
    'page',
    pages.map((page) => page.id),
  );
  const current = pages.find((page) => page.id === editor.selected) ?? null;
  const creating = editor.selected === NEW;

  return (
    <>
      {pages.length === 0 ? (
        <EmptyState
          icon={RadioTower}
          title={t('empty.title')}
          hint={t('empty.hint')}
          action={<NewStatusPageButton />}
        />
      ) : (
        <section className="card overflow-hidden">
          <ul className="list is-link">
            {pages.map((page) => {
              const services = page.blocks
                .filter((block) => block.type === 'services')
                .reduce((sum, block) => sum + block.items.length, 0);
              return (
                <li
                  key={page.id}
                  className={cn(
                    'relative flex-wrap gap-y-1 sm:flex-nowrap',
                    page.id === editor.selected && 'is-selected',
                  )}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <button
                      type="button"
                      className="text-left font-medium text-text after:absolute after:inset-0"
                      aria-label={t('row.open', { title: page.title })}
                      onClick={() => editor.open(page.id)}
                    >
                      {page.title}
                    </button>
                    <span className="mono t-cap text-text-2">
                      {page.path} · {t('row.services', { count: services })}
                    </span>
                  </span>
                  <Badge variant={page.published ? 'ok' : 'idle'} dot>
                    {page.published ? t('row.published') : t('row.draft')}
                  </Badge>
                  {page.published ? (
                    <a
                      href={page.path}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btn-ghost btn-sm relative z-[1] shrink-0"
                    >
                      {t('row.view')}
                      <ExternalLink aria-hidden />
                    </a>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <Drawer
        open={creating || current !== null}
        onOpenChange={(open) => (open ? undefined : editor.close())}
        xwide
        label={current?.title ?? t('editor.title.new')}
      >
        {creating || current ? (
          <StatusPageEditor
            key={current?.id ?? NEW}
            initial={current}
            takenSlugs={pages.filter((page) => page.id !== current?.id).map((page) => page.slug)}
            monitors={monitors}
            format={format}
            onSaved={(saved) => {
              if (creating) editor.select(saved.id, 'replace');
              router.refresh();
            }}
            onDeleted={() => {
              editor.close();
              router.refresh();
            }}
            onCancel={() => editor.close()}
          />
        ) : null}
      </Drawer>
    </>
  );
}

function StatusPageEditor({
  initial,
  takenSlugs,
  monitors,
  format,
  onSaved,
  onDeleted,
  onCancel,
}: {
  initial: StatusPageJson | null;
  takenSlugs: string[];
  monitors: MonitorOption[];
  format: FormatSettings;
  onSaved: (page: StatusPageJson) => void;
  onDeleted: () => void;
  onCancel: () => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const [title, setTitle] = React.useState(initial?.title ?? '');
  // Une première page prend `/status` ; les suivantes demandent leur adresse.
  const [slug, setSlug] = React.useState(
    () => initial?.slug ?? (takenSlugs.includes('') ? 'clients' : ''),
  );
  const [description, setDescription] = React.useState(initial?.description ?? '');
  const [published, setPublished] = React.useState(initial?.published ?? false);
  const [blocks, setBlocks] = React.useState<StatusBlock[]>(
    () => initial?.blocks ?? [blankBlock('summary')],
  );
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [deletePending, setDeletePending] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);

  const slugTaken = takenSlugs.includes(slug.trim());
  const blocking = title.trim() === '' || slugTaken || blocks.some(incomplete);

  function update(index: number, block: StatusBlock) {
    setBlocks((list) => list.map((current, position) => (position === index ? block : current)));
  }

  function move(from: number, to: number) {
    setBlocks((list) => {
      if (to < 0 || to >= list.length || from === to) return list;
      const next = [...list];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      return next;
    });
  }

  async function save() {
    setPending(true);
    setError(null);
    const response = await fetch(
      initial ? `/api/status-pages/${initial.id}` : '/api/status-pages',
      {
        method: initial ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title,
          slug: slug.trim(),
          description: description.trim() === '' ? null : description,
          published,
          blocks,
        }),
      },
    );
    setPending(false);
    if (!response.ok) {
      setError(await failure(response, tc('http.failure', { status: response.status })));
      return;
    }
    const saved = (await response.json()) as StatusPageJson;
    toast({
      title: t(initial ? 'toast.saved' : 'toast.created', { title: saved.title }),
      tone: 'ok',
    });
    onSaved(saved);
  }

  async function remove() {
    if (!initial) return;
    setDeletePending(true);
    setDeleteError(null);
    const response = await fetch(`/api/status-pages/${initial.id}`, { method: 'DELETE' });
    setDeletePending(false);
    if (!response.ok) {
      setDeleteError(await failure(response, tc('http.failure', { status: response.status })));
      return;
    }
    toast({ title: t('toast.deleted', { title: initial.title }), tone: 'ok' });
    setDeleting(false);
    onDeleted();
  }

  return (
    <>
      <DrawerHeader
        icon={<RadioTower aria-hidden />}
        kind={t('editor.kind')}
        title={initial ? initial.title : t('editor.title.new')}
        state={
          initial ? (
            <Badge variant={initial.published ? 'ok' : 'idle'} dot>
              {initial.published ? t('row.published') : t('row.draft')}
            </Badge>
          ) : undefined
        }
      />
      <DrawerBody className="!p-0">
        <div className="grid min-h-full grid-cols-1 lg:grid-cols-[minmax(0,440px)_minmax(0,1fr)]">
          <div className="flex flex-col gap-5 border-border p-5 lg:border-r">
            <DrawerSection title={t('editor.settings')}>
              <div className="flex flex-col gap-3">
                <Field label={t('editor.field.title')}>
                  <Input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder={t('editor.field.title.placeholder')}
                    maxLength={120}
                  />
                </Field>
                <Field
                  label={t('editor.field.slug')}
                  help={t('editor.field.slug.help')}
                  error={
                    slugTaken
                      ? t('error.slugTaken', { path: statusPagePath(slug.trim()) })
                      : undefined
                  }
                >
                  <div className="flex items-center gap-1.5">
                    <span className="mono t-sm text-text-3">/status/</span>
                    <Input
                      value={slug}
                      onChange={(event) => setSlug(event.target.value.toLowerCase())}
                      placeholder="clients"
                      maxLength={60}
                      className="mono"
                    />
                  </div>
                </Field>
                <Field
                  label={t('editor.field.description')}
                  help={t('editor.field.description.help')}
                  optional
                >
                  <Textarea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    rows={2}
                    maxLength={500}
                  />
                </Field>
                <SwitchField
                  label={t('editor.field.published')}
                  help={t('editor.field.published.help')}
                  checked={published}
                  onChange={(event) => setPublished(event.target.checked)}
                />
              </div>
            </DrawerSection>

            <DrawerSection title={t('editor.blocks')}>
              <p className="t-cap -mt-1 mb-2 text-text-3">{t('editor.blocks.hint')}</p>
              <BlockList
                blocks={blocks}
                monitors={monitors}
                onChange={update}
                onMove={move}
                onRemove={(index) =>
                  setBlocks((list) => list.filter((_, position) => position !== index))
                }
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary" className="mt-2 self-start">
                    <Plus aria-hidden />
                    {t('editor.add')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {STATUS_BLOCK_TYPES.map((type) => (
                    <DropdownMenuItem
                      key={type}
                      onSelect={() => setBlocks((list) => [...list, blankBlock(type)])}
                    >
                      <span className="flex flex-col">
                        <span className="font-medium">{t(`block.${type}`)}</span>
                        <span className="t-cap text-text-3">{t(`block.${type}.hint`)}</span>
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </DrawerSection>

            {error ? (
              <p role="alert" className="t-sm text-danger-text">
                {error}
              </p>
            ) : null}
          </div>

          {/* L'aperçu reste en vue pendant qu'on fait défiler les blocs. */}
          <div className="bg-bg p-5 lg:sticky lg:top-0 lg:max-h-full lg:self-start lg:overflow-y-auto">
            <p className="t-cap mb-3 font-medium uppercase tracking-wide text-text-3">
              {t('editor.preview')}
            </p>
            <Preview title={title} description={description} blocks={blocks} format={format} />
          </div>
        </div>
      </DrawerBody>
      <DrawerFooter
        end={
          initial ? (
            <span className="flex items-center gap-2">
              {initial.published ? (
                <a href={initial.path} target="_blank" rel="noreferrer" className="btn btn-ghost">
                  {t('editor.openPublic')}
                  <ExternalLink aria-hidden />
                </a>
              ) : null}
              <Button variant="ghost" onClick={() => setDeleting(true)}>
                <Trash2 aria-hidden />
                {t('editor.delete')}
              </Button>
            </span>
          ) : null
        }
      >
        <Button loading={pending} disabled={blocking} onClick={save}>
          {initial ? t('editor.save') : t('editor.save.new')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t('editor.cancel')}
        </Button>
      </DrawerFooter>

      <ConfirmDialog
        open={deleting}
        onOpenChange={(open) => (open ? undefined : setDeleting(false))}
        level="trace"
        title={t('confirm.delete.title', { title: initial?.title ?? '' })}
        consequences={[t('confirm.delete.consequence', { path: initial?.path ?? '' })]}
        confirmLabel={t('confirm.delete.action')}
        pending={deletePending}
        error={deleteError}
        onConfirm={remove}
      />
    </>
  );
}

/**
 * Les blocs, réordonnables : par glisser-déposer à la souris (poignée), ou au
 * clavier par leurs flèches — le glisser-déposer natif n'a pas d'équivalent
 * clavier.
 */
function BlockList({
  blocks,
  monitors,
  onChange,
  onMove,
  onRemove,
}: {
  blocks: StatusBlock[];
  monitors: MonitorOption[];
  onChange: (index: number, block: StatusBlock) => void;
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
}) {
  const t = useT(messages);
  const [dragging, setDragging] = React.useState<number | null>(null);
  const [over, setOver] = React.useState<number | null>(null);

  if (blocks.length === 0) return <p className="t-sm text-text-3">{t('editor.blocks.empty')}</p>;

  return (
    <ol className="flex flex-col gap-2">
      {blocks.map((block, index) => (
        <li
          key={block.id}
          onDragOver={(event) => {
            if (dragging === null) return;
            event.preventDefault();
            setOver(index);
          }}
          onDrop={(event) => {
            event.preventDefault();
            if (dragging !== null) onMove(dragging, index);
            setDragging(null);
            setOver(null);
          }}
          className={cn(
            'rounded-lg border border-border bg-surface',
            dragging === index && 'opacity-50',
            over === index && dragging !== null && dragging !== index && 'ring-2 ring-accent',
          )}
          data-block-type={block.type}
        >
          <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
            <span
              draggable
              role="button"
              tabIndex={-1}
              aria-label={t('editor.handle', { label: t(`block.${block.type}`) })}
              className="cursor-grab rounded p-1 text-text-3 hover:bg-bg active:cursor-grabbing"
              onDragStart={(event) => {
                setDragging(index);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', block.id);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
            >
              <GripVertical className="size-4" aria-hidden />
            </span>
            <span className="t-sm min-w-0 flex-1 font-medium text-text">
              {t(`block.${block.type}`)}
            </span>
            <IconButton
              label={t('editor.move.up')}
              size="icon-sm"
              disabled={index === 0}
              onClick={() => onMove(index, index - 1)}
            >
              <ArrowUp />
            </IconButton>
            <IconButton
              label={t('editor.move.down')}
              size="icon-sm"
              disabled={index === blocks.length - 1}
              onClick={() => onMove(index, index + 1)}
            >
              <ArrowDown />
            </IconButton>
            <IconButton label={t('editor.remove')} size="icon-sm" onClick={() => onRemove(index)}>
              <X />
            </IconButton>
          </div>
          <div className="p-3">
            <BlockFields
              block={block}
              monitors={monitors}
              onChange={(next) => onChange(index, next)}
              t={t}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}

function BlockFields({
  block,
  monitors,
  onChange,
  t,
}: {
  block: StatusBlock;
  monitors: MonitorOption[];
  onChange: (block: StatusBlock) => void;
  t: T;
}) {
  switch (block.type) {
    case 'summary':
    case 'maintenance':
      return <p className="t-cap text-text-3">{t(`block.${block.type}.hint`)}</p>;
    case 'heading':
      return (
        <Input
          value={block.text}
          onChange={(event) => onChange({ ...block, text: event.target.value })}
          aria-label={t('block.heading')}
          maxLength={120}
        />
      );
    case 'text':
      return (
        <Textarea
          value={block.text}
          onChange={(event) => onChange({ ...block, text: event.target.value })}
          aria-label={t('block.field.text')}
          rows={3}
          maxLength={2000}
        />
      );
    case 'incidents':
      return (
        <Field label={t('block.field.days')}>
          <Select
            value={String(block.days)}
            onChange={(event) =>
              onChange({
                ...block,
                days: Number(event.target.value) as (typeof STATUS_PAGE_INCIDENT_DAYS)[number],
              })
            }
          >
            {STATUS_PAGE_INCIDENT_DAYS.map((days) => (
              <option key={days} value={days}>
                {t('block.field.days.option', { count: days })}
              </option>
            ))}
          </Select>
        </Field>
      );
    case 'services': {
      const available = monitors.filter(
        (monitor) => !block.items.some((item) => item.monitorId === monitor.id),
      );
      const name = (id: string) => monitors.find((monitor) => monitor.id === id)?.name ?? id;
      const moveItem = (from: number, to: number) => {
        if (to < 0 || to >= block.items.length) return;
        const items = [...block.items];
        const [moved] = items.splice(from, 1);
        items.splice(to, 0, moved!);
        onChange({ ...block, items });
      };
      return (
        <div className="flex flex-col gap-3">
          <Field label={t('block.field.groupTitle')} optional>
            <Input
              value={block.title ?? ''}
              onChange={(event) =>
                onChange({ ...block, title: event.target.value === '' ? null : event.target.value })
              }
              placeholder={t('block.field.groupTitle.placeholder')}
              maxLength={120}
            />
          </Field>
          {block.items.length === 0 ? (
            <p className="t-sm text-danger-text">{t('block.services.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {block.items.map((item, index) => (
                <li key={item.monitorId} className="flex items-center gap-1">
                  <Input
                    value={item.label ?? ''}
                    placeholder={t('block.field.label.placeholder', { name: name(item.monitorId) })}
                    aria-label={t('block.field.label', { name: name(item.monitorId) })}
                    maxLength={80}
                    onChange={(event) =>
                      onChange({
                        ...block,
                        items: block.items.map((current, position) =>
                          position === index
                            ? {
                                ...current,
                                label: event.target.value === '' ? null : event.target.value,
                              }
                            : current,
                        ),
                      })
                    }
                  />
                  <IconButton
                    label={t('editor.move.up')}
                    size="icon-sm"
                    disabled={index === 0}
                    onClick={() => moveItem(index, index - 1)}
                  >
                    <ArrowUp />
                  </IconButton>
                  <IconButton
                    label={t('editor.move.down')}
                    size="icon-sm"
                    disabled={index === block.items.length - 1}
                    onClick={() => moveItem(index, index + 1)}
                  >
                    <ArrowDown />
                  </IconButton>
                  <IconButton
                    label={t('block.field.removeService', { name: name(item.monitorId) })}
                    size="icon-sm"
                    onClick={() =>
                      onChange({
                        ...block,
                        items: block.items.filter((_, position) => position !== index),
                      })
                    }
                  >
                    <X />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
          {available.length > 0 ? (
            <Select
              value=""
              aria-label={t('block.field.addService')}
              onChange={(event) => {
                if (!event.target.value) return;
                onChange({
                  ...block,
                  items: [...block.items, { monitorId: event.target.value, label: null }],
                });
              }}
            >
              <option value="">{t('block.field.addService')}</option>
              {available.map((monitor) => (
                <option key={monitor.id} value={monitor.id}>
                  {monitor.name}
                </option>
              ))}
            </Select>
          ) : block.items.length === 0 ? (
            <p className="t-cap text-text-3">{t('block.field.noMonitor')}</p>
          ) : null}
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <SwitchField
              label={t('block.field.history')}
              checked={block.history}
              onChange={(event) => onChange({ ...block, history: event.target.checked })}
            />
            <SwitchField
              label={t('block.field.uptime')}
              checked={block.uptime}
              onChange={(event) => onChange({ ...block, uptime: event.target.checked })}
            />
          </div>
        </div>
      );
    }
  }
}

/**
 * L'aperçu : la page telle qu'un visiteur la lirait, recalculée au serveur
 * une fraction de seconde après la dernière frappe. Les blocs encore
 * incomplets n'y figurent pas.
 */
function Preview({
  title,
  description,
  blocks,
  format,
}: {
  title: string;
  description: string;
  blocks: StatusBlock[];
  format: FormatSettings;
}) {
  const t = useT(messages);
  const [state, setState] = React.useState<StatusPageModel | 'loading' | { error: string }>(
    'loading',
  );
  const body = JSON.stringify({
    slug: '',
    title: title.trim() === '' ? t('editor.field.title.placeholder') : title,
    description: description.trim() === '' ? null : description,
    blocks: blocks.filter((block) => !incomplete(block)),
  });

  React.useEffect(() => {
    let alive = true;
    const timer = window.setTimeout(() => {
      fetch('/api/status-pages/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(await failure(response, String(response.status)));
          return (await response.json()) as StatusPageModel;
        })
        .then((model) => {
          if (alive) setState(model);
        })
        .catch((error: Error) => {
          if (alive) setState({ error: error.message });
        });
    }, 400);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [body]);

  if (state === 'loading') return <p className="t-sm text-text-3">{t('editor.preview.loading')}</p>;
  if ('error' in state) {
    return (
      <p className="t-sm text-danger-text">
        {t('editor.preview.failed', { message: state.error })}
      </p>
    );
  }
  return <StatusPageView model={state} format={format} compact />;
}
