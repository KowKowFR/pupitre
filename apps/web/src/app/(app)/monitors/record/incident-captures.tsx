'use client';

/*
 * `<img>` and not `next/image`, deliberately.
 *
 * Next's image optimizer would serve these files again through its own route
 * and keep variants of them in its disk cache — that is, an image protected by
 * `monitor:read` would end up copied outside the path that checks that
 * permission. There is nothing to optimize anyway: the capture is already a
 * quality-70 JPEG, at the exact dimensions it is shown at, served with an
 * immutable cache. We lose the generation of multiple sizes, which makes no
 * sense for a thumbnail and a "full size" link.
 */
/* eslint-disable @next/next/no-img-element */

import * as React from 'react';
import type { CaptureKind, Translate } from '@pupitre/core';
import { Badge } from '@/components/ui/badge';
import { useT } from '@/i18n/client';
import { monitors as messages } from '@/i18n/messages/monitors';
import { formatDateTimeWith, formatNumber, type FormatSettings } from '@/lib/format';

/**
 * What the probe saw — an incident's images.
 *
 * ── Why a component dedicated to comparison ─────────────────────────────────
 * Putting three thumbnails side by side would already be useful. It would not
 * answer the question one really asks in front of an outage: **what changed?**
 * Two almost identical pages, one of which lost its cart or gained an error
 * banner, the eye does not tell apart by looking at one after the other — it
 * tells them apart by overlaying them.
 *
 * Hence the slider: the two images occupy exactly the same rectangle, and one is
 * revealed under the other. It is the most useful screen of the batch, and it
 * only costs a few lines because a `clip-path` driven by an `<input
 * type="range">` is enough — no mouse drag and drop, hence usable with the
 * keyboard without adding anything.
 *
 * The thumbnails stay below: the comparison does not replace being able to look
 * at an image whole, at full size, in a tab.
 */

export type CaptureView = {
  id: string;
  kind: CaptureKind;
  takenAt: string;
  url: string;
  finalUrl: string | null;
  httpStatus: number | null;
  pageTitle: string | null;
  width: number;
  height: number;
  bytes: number;
  truncated: boolean;
  hasImage: boolean;
  purgedAt: string | null;
};

type Messages = Translate<(typeof messages)['fr']>;

/**
 * A capture's instant. Components imposed by the thumbnail, locale taken from the
 * instance settings — `settings.locale` as is, never reduced to two letters, and
 * passed down through props so that the server and the client read the same
 * value.
 */
function formatClock(iso: string, format: FormatSettings): string {
  return formatDateTimeWith(iso, format, {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * The megabyte goes through a number formatter rather than a
 * `replace('.', ',')`: the decimal comma is a property of the locale, not of
 * French. And it is indeed the **instance**'s locale — `fr-FR`, `en-GB` —, not the
 * two-letter language, for the reason that holds for dates.
 */
function formatBytes(bytes: number, t: Messages, format: FormatSettings): string {
  if (bytes < 1024) return t('capture.bytes.b', { value: bytes });
  if (bytes < 1024 * 1024) return t('capture.bytes.kb', { value: Math.round(bytes / 1024) });
  const megabytes = formatNumber(bytes / (1024 * 1024), format, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return t('capture.bytes.mb', { value: megabytes });
}

/** A capture's short name, in the order it is looked at. */
function kindLabel(kind: CaptureKind, t: Messages): string {
  if (kind === 'reference') return t('capture.kind.reference');
  if (kind === 'incident_open') return t('capture.kind.incidentOpen');
  return t('capture.kind.incidentResolved');
}

function href(monitorId: string, capture: CaptureView): string {
  return `/api/monitors/${monitorId}/captures/${capture.id}`;
}

/** A line of facts under an image. Readable without looking at the image. */
function CaptureFacts({ capture, format }: { capture: CaptureView; format: FormatSettings }) {
  const t = useT(messages);
  return (
    <div className="t-cap flex flex-wrap items-center gap-1.5 text-text-2">
      <span className="mono">{formatClock(capture.takenAt, format)}</span>
      {capture.httpStatus === null ? null : (
        <Badge variant="outline">{t('capture.status', { status: capture.httpStatus })}</Badge>
      )}
      <span className="mono">
        {capture.width}×{capture.height} · {formatBytes(capture.bytes, t, format)}
      </span>
      {capture.truncated ? (
        <Badge title={t('capture.truncated.title')}>{t('capture.truncated')}</Badge>
      ) : null}
    </div>
  );
}

function CaptureThumb({
  monitorId,
  capture,
  format,
}: {
  monitorId: string;
  capture: CaptureView;
  format: FormatSettings;
}) {
  const t = useT(messages);
  return (
    <figure className="min-w-0 space-y-1.5">
      <figcaption className="t-cap font-medium text-text-3">
        {kindLabel(capture.kind, t)}
      </figcaption>
      {capture.hasImage ? (
        <a
          href={href(monitorId, capture)}
          target="_blank"
          rel="noreferrer"
          className="block overflow-hidden rounded-lg border border-border"
          title={t('capture.openFull')}
        >
          {/* Framed at the top: a broken page's diagnosis is at the top. */}
          <img
            src={href(monitorId, capture)}
            alt={t('capture.alt', {
              kind: kindLabel(capture.kind, t),
              clock: formatClock(capture.takenAt, format),
            })}
            loading="lazy"
            className="h-40 w-full bg-white object-cover object-top"
          />
        </a>
      ) : (
        <div className="t-cap flex h-40 items-center justify-center rounded-lg border border-border bg-surface-2 px-3 text-center text-text-2">
          {t('capture.purged', {
            when: capture.purgedAt
              ? t('capture.purged.on', { clock: formatClock(capture.purgedAt, format) })
              : '',
            size: formatBytes(capture.bytes, t, format),
          })}
        </div>
      )}
      <CaptureFacts capture={capture} format={format} />
    </figure>
  );
}

/**
 * The comparator. Two images in the same rectangle, a slider to reveal.
 *
 * The common height is the **smaller of the two**: stretching the shorter one
 * would shift everything and show a difference that does not exist. What goes
 * beyond is simply cut, and the "full size" link stays there for the rest.
 */
function CaptureSlider({
  monitorId,
  before,
  after,
  format,
}: {
  monitorId: string;
  before: CaptureView;
  after: CaptureView;
  format: FormatSettings;
}) {
  const t = useT(messages);
  const [position, setPosition] = React.useState(50);
  const height = Math.min(before.height, after.height);

  return (
    <div className="space-y-2">
      <div
        className="relative w-full overflow-hidden rounded-lg border border-border bg-white"
        style={{ aspectRatio: `${before.width} / ${height}` }}
      >
        <img
          src={href(monitorId, after)}
          alt={t('slider.during.alt', { clock: formatClock(after.takenAt, format) })}
          className="absolute inset-0 h-full w-full object-cover object-top"
        />
        <img
          src={href(monitorId, before)}
          alt={t('slider.before.alt', { clock: formatClock(before.takenAt, format) })}
          className="absolute inset-0 h-full w-full object-cover object-top"
          style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
        />
        <div
          className="pointer-events-none absolute top-0 bottom-0 w-px"
          style={{ left: `${position}%`, background: 'var(--danger)' }}
        />
        <span className="absolute top-1 left-1 rounded bg-black/70 px-1.5 py-0.5 text-[0.625rem] text-white">
          {t('slider.before.badge', { clock: formatClock(before.takenAt, format) })}
        </span>
        <span className="absolute top-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[0.625rem] text-white">
          {t('slider.during.badge', { clock: formatClock(after.takenAt, format) })}
        </span>
      </div>
      <label className="t-cap flex items-center gap-3 text-text-2">
        <span className="shrink-0">{t('slider.reveal')}</span>
        <input
          type="range"
          min={0}
          max={100}
          value={position}
          onChange={(event) => setPosition(Number(event.target.value))}
          className="w-full"
          aria-label={t('slider.aria')}
        />
        <span className="w-10 shrink-0 text-right font-mono">
          {t('slider.percent', { value: position })}
        </span>
      </label>
    </div>
  );
}

/**
 * The live reference — "here is what this site looks like when it is fine".
 *
 * Shown outside any timeline because it does not tell an incident: it is the
 * standard the next one will be compared to. Showing it also serves to prove, on
 * a probe that never went down, that capture works — otherwise the feature would
 * stay invisible until the first outage.
 */
export function LiveReferenceCard({
  monitorId,
  capture,
  format,
}: {
  monitorId: string;
  capture: CaptureView | null;
  format: FormatSettings;
}) {
  const t = useT(messages);
  if (capture === null) return null;
  return (
    <section className="card">
      <div className="card-h">
        <h2>{t('reference.title')}</h2>
        <span className="sub">{t('reference.description')}</span>
      </div>
      <div className="card-b">
        <div className="max-w-md">
          <CaptureThumb monitorId={monitorId} capture={capture} format={format} />
        </div>
      </div>
    </section>
  );
}

export function IncidentCaptures({
  monitorId,
  captures,
  format,
}: {
  monitorId: string;
  captures: CaptureView[];
  format: FormatSettings;
}) {
  const t = useT(messages);
  if (captures.length === 0) return null;

  const before = captures.find((capture) => capture.kind === 'reference') ?? null;
  const during = captures.find((capture) => capture.kind === 'incident_open') ?? null;
  const after = captures.find((capture) => capture.kind === 'incident_resolved') ?? null;
  const ordered = [before, during, after].filter(
    (capture): capture is CaptureView => capture !== null,
  );

  const comparable = before !== null && during !== null && before.hasImage && during.hasImage;

  return (
    <div className="well flex flex-col gap-3">
      <div className="t-cap font-medium text-text-3">{t('captures.title')}</div>

      {comparable ? (
        <CaptureSlider monitorId={monitorId} before={before} after={during} format={format} />
      ) : (
        <p className="t-sm text-text-2">
          {before === null ? t('captures.noReference') : t('captures.incomplete')}
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {ordered.map((capture) => (
          <CaptureThumb key={capture.id} monitorId={monitorId} capture={capture} format={format} />
        ))}
      </div>
    </div>
  );
}
