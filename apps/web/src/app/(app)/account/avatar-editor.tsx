'use client';

/* eslint-disable @next/next/no-img-element -- des aperçus locaux (blob:) et une URL d'API versionnée */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Camera, ImageUp, Trash2 } from 'lucide-react';
import { avatarSrc } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { initialsOf } from '@/components/ui/data';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useT } from '@/i18n/client';
import { account as messages } from '@/i18n/messages/account';
import { common } from '@/i18n/messages/common';
import { ImagePrepError, cropAvatar, loadImage, type CropSquare } from '@/lib/image-prep';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/**
 * La photo de profil, sur « Mon compte ».
 *
 * Un clic sur le visage ouvre le recadrage : l'image se déplace à la souris,
 * au doigt ou aux flèches, se zoome à la molette, au curseur ou avec + et −.
 * Le cercle montre ce qui restera ; deux aperçus le montrent à la taille où on
 * le verra vraiment. Le navigateur exporte un carré de 256 px — voir
 * `image-prep.ts` —, le serveur le relit et le range.
 */

const VIEW = 280;
const MAX_ZOOM = 4;

type Source = { url: string; image: HTMLImageElement };
type View = { zoom: number; x: number; y: number };

type ApiError = { error?: { message?: string } };

/** Ce que montre la fenêtre de recadrage, dérivé de l'image et du cadrage. */
function geometry(image: HTMLImageElement, view: View) {
  const scale = (VIEW / Math.min(image.naturalWidth, image.naturalHeight)) * view.zoom;
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  const left = (VIEW - width) / 2 + view.x;
  const top = (VIEW - height) / 2 + view.y;
  return { scale, width, height, left, top };
}

/** L'image couvre toujours le cercle : on ne la pousse pas au-delà de son bord. */
function clamp(image: HTMLImageElement, view: View): View {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, view.zoom));
  const { width, height } = geometry(image, { ...view, zoom });
  const maxX = Math.max(0, (width - VIEW) / 2);
  const maxY = Math.max(0, (height - VIEW) / 2);
  return {
    zoom,
    x: Math.min(maxX, Math.max(-maxX, view.x)),
    y: Math.min(maxY, Math.max(-maxY, view.y)),
  };
}

function cropOf(image: HTMLImageElement, view: View): CropSquare {
  const { scale, left, top } = geometry(image, view);
  return { x: -left / scale, y: -top / scale, size: VIEW / scale };
}

export function AvatarEditor({ name, image }: { name: string; image: string | null }) {
  const t = useT(messages);
  const tc = useT(common);
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [source, setSource] = React.useState<Source | null>(null);
  const [view, setView] = React.useState<View>({ zoom: 1, x: 0, y: 0 });
  const [busy, setBusy] = React.useState<'save' | 'remove' | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [dragOver, setDragOver] = React.useState(false);
  const input = React.useRef<HTMLInputElement>(null);
  const frame = React.useRef<HTMLDivElement>(null);
  const drag = React.useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const current = avatarSrc(image);

  // L'aperçu local vit le temps du recadrage.
  React.useEffect(
    () => () => {
      if (source) URL.revokeObjectURL(source.url);
    },
    [source],
  );

  function reset() {
    setSource(null);
    setView({ zoom: 1, x: 0, y: 0 });
    setError(null);
    setDragOver(false);
  }

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      const decoded = await loadImage(file);
      setSource({ url: URL.createObjectURL(file), image: decoded });
      setView({ zoom: 1, x: 0, y: 0 });
    } catch {
      setError(t('avatar.error.read'));
    }
  }

  const zoomTo = React.useCallback(
    (zoom: number) => {
      if (!source) return;
      setView((previous) => {
        // Le point au centre du cercle reste au centre.
        const ratio = Math.min(MAX_ZOOM, Math.max(1, zoom)) / previous.zoom;
        return clamp(source.image, { zoom, x: previous.x * ratio, y: previous.y * ratio });
      });
    },
    [source],
  );

  // La molette zoome : écouteur natif, non passif, pour retenir le défilement.
  React.useEffect(() => {
    const node = frame.current;
    if (!node || !source) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setView((previous) => {
        const zoom = Math.min(MAX_ZOOM, Math.max(1, previous.zoom * Math.exp(-event.deltaY / 400)));
        const ratio = zoom / previous.zoom;
        return clamp(source.image, { zoom, x: previous.x * ratio, y: previous.y * ratio });
      });
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [source]);

  async function save() {
    if (!source) return;
    setBusy('save');
    setError(null);
    try {
      const blob = await cropAvatar(source.image, cropOf(source.image, view));
      const response = await fetch('/api/account/avatar', {
        method: 'PUT',
        headers: { 'content-type': blob.type },
        body: blob,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as ApiError;
        setError(body.error?.message ?? tc('http.failure', { status: response.status }));
        return;
      }
      toast({ title: t('avatar.saved'), tone: 'ok' });
      setOpen(false);
      reset();
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof ImagePrepError
          ? t('avatar.error.read')
          : tc('http.failure', { status: 0 }),
      );
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy('remove');
    setError(null);
    const response = await fetch('/api/account/avatar', { method: 'DELETE' }).catch(() => null);
    setBusy(null);
    if (!response?.ok) {
      setError(tc('http.failure', { status: response?.status ?? 0 }));
      return;
    }
    toast({ title: t('avatar.removed'), tone: 'ok' });
    setOpen(false);
    reset();
    router.refresh();
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (!source) return;
    const step = event.shiftKey ? 24 : 8;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      setView((previous) =>
        clamp(source.image, { ...previous, x: previous.x + move[0], y: previous.y + move[1] }),
      );
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomTo(view.zoom + 0.1);
    } else if (event.key === '-') {
      event.preventDefault();
      zoomTo(view.zoom - 0.1);
    }
  }

  const shown = source ? geometry(source.image, view) : null;
  const preview = (size: number) =>
    source && shown ? (
      <span
        className="relative block shrink-0 overflow-hidden rounded-full border border-border bg-surface-2"
        style={{ width: size, height: size }}
      >
        <img
          src={source.url}
          alt=""
          draggable={false}
          className="absolute max-w-none"
          style={{
            width: shown.width * (size / VIEW),
            height: shown.height * (size / VIEW),
            left: shown.left * (size / VIEW),
            top: shown.top * (size / VIEW),
          }}
        />
      </span>
    ) : null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('avatar.edit')}
        title={t('avatar.edit')}
        className="group relative size-16 shrink-0 rounded-full focus-visible:shadow-focus focus-visible:outline-none"
      >
        {current ? (
          <img
            src={current}
            alt=""
            className="size-16 rounded-full border border-border object-cover"
          />
        ) : (
          <span
            aria-hidden
            className="grid size-16 place-items-center rounded-full border border-accent-line bg-accent-soft text-[20px] font-semibold text-accent-text"
          >
            {initialsOf(name)}
          </span>
        )}
        <span
          aria-hidden
          className="absolute -right-0.5 -bottom-0.5 grid size-6 place-items-center rounded-full border border-border bg-surface text-text-2 shadow-sm transition-colors group-hover:text-text"
        >
          <Camera className="size-3.5" />
        </span>
      </button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogContent>
          <DialogHeader icon={<ImageUp />} tone="accent">
            <DialogTitle>{t('avatar.dialog.title')}</DialogTitle>
            <DialogDescription>{t('avatar.dialog.description')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col items-center gap-4">
            <input
              ref={input}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="sr-only"
              tabIndex={-1}
              onChange={(event) => {
                void pick(event.target.files?.[0]);
                event.target.value = '';
              }}
            />

            {source && shown ? (
              <>
                <div
                  ref={frame}
                  role="group"
                  tabIndex={0}
                  aria-label={t('avatar.crop.label')}
                  onKeyDown={onKeyDown}
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture(event.pointerId);
                    drag.current = { px: event.clientX, py: event.clientY, x: view.x, y: view.y };
                  }}
                  onPointerMove={(event) => {
                    const start = drag.current;
                    if (!start) return;
                    setView((previous) =>
                      clamp(source.image, {
                        ...previous,
                        x: start.x + event.clientX - start.px,
                        y: start.y + event.clientY - start.py,
                      }),
                    );
                  }}
                  onPointerUp={() => (drag.current = null)}
                  onPointerCancel={() => (drag.current = null)}
                  className="relative cursor-grab touch-none overflow-hidden rounded-xl bg-surface-2 select-none focus-visible:shadow-focus focus-visible:outline-none active:cursor-grabbing"
                  style={{ width: VIEW, height: VIEW }}
                >
                  <img
                    src={source.url}
                    alt=""
                    draggable={false}
                    className="pointer-events-none absolute max-w-none"
                    style={{
                      width: shown.width,
                      height: shown.height,
                      left: shown.left,
                      top: shown.top,
                    }}
                  />
                  {/* Ce qui restera : le cercle, le reste voilé. */}
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-0 rounded-full"
                    style={{ boxShadow: '0 0 0 9999px rgb(10 12 16 / 0.55)' }}
                  />
                </div>

                <div className="flex w-full max-w-[280px] items-center gap-3">
                  <label className="t-cap shrink-0 text-text-2" htmlFor="avatar-zoom">
                    {t('avatar.zoom')}
                  </label>
                  <input
                    id="avatar-zoom"
                    type="range"
                    min={1}
                    max={MAX_ZOOM}
                    step={0.01}
                    value={view.zoom}
                    onChange={(event) => zoomTo(Number(event.target.value))}
                    className="flex-1 accent-[var(--accent)]"
                  />
                </div>

                <div className="flex items-center gap-3">
                  {preview(64)}
                  {preview(32)}
                  {preview(24)}
                  <Button variant="ghost" size="sm" onClick={() => input.current?.click()}>
                    {t('avatar.choose.other')}
                  </Button>
                </div>
              </>
            ) : (
              <label
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragOver(false);
                  void pick(event.dataTransfer.files[0]);
                }}
                className={cn(
                  'flex w-full cursor-pointer flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-8 text-center transition-colors',
                  dragOver
                    ? 'border-accent bg-accent-soft'
                    : 'border-border-strong hover:bg-surface-2',
                )}
              >
                {current ? (
                  <img
                    src={current}
                    alt=""
                    className="size-20 rounded-full border border-border object-cover"
                  />
                ) : (
                  <span className="grid size-20 place-items-center rounded-full border border-accent-line bg-accent-soft text-[24px] font-semibold text-accent-text">
                    {initialsOf(name)}
                  </span>
                )}
                <Button type="button" variant="secondary" onClick={() => input.current?.click()}>
                  <ImageUp aria-hidden />
                  {t('avatar.choose')}
                </Button>
                <span className="t-cap text-text-3">{t('avatar.drop')}</span>
              </label>
            )}

            {error ? (
              <Alert variant="destructive" className="w-full">
                {error}
              </Alert>
            ) : null}
          </DialogBody>
          <DialogFooter>
            {current && !source ? (
              <Button
                variant="ghost"
                className="text-danger-text"
                loading={busy === 'remove'}
                disabled={busy !== null}
                onClick={() => void remove()}
              >
                {busy === 'remove' ? null : <Trash2 aria-hidden />}
                {t('avatar.remove')}
              </Button>
            ) : null}
            <span className="ml-auto flex items-center gap-2">
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy !== null}>
                {tc('cancel')}
              </Button>
              <Button
                loading={busy === 'save'}
                disabledReason={source ? null : t('avatar.choose')}
                disabled={busy !== null}
                onClick={() => void save()}
              >
                {t('avatar.save')}
              </Button>
            </span>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
