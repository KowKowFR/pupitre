'use client';

/*
 * `<img>` et non `next/image`, délibérément.
 *
 * L'optimiseur d'images de Next re-servirait ces fichiers par sa propre route
 * et en garderait des variantes dans son cache disque — c'est-à-dire qu'une
 * image protégée par `monitor:read` se retrouverait recopiée hors du chemin qui
 * vérifie cette permission. Il n'y a par ailleurs rien à optimiser : la capture
 * est déjà un JPEG de qualité 70, aux dimensions exactes où on l'affiche, servi
 * avec un cache immuable. On perd la génération de tailles multiples, ce qui
 * n'a pas de sens pour une vignette et un lien « taille réelle ».
 */
/* eslint-disable @next/next/no-img-element */

import * as React from 'react';
import type { CaptureKind, Translate } from '@pupitre/core';
import { Badge } from '@/components/ui/badge';
import { useT } from '@/i18n/client';
import { monitors as messages } from '@/i18n/messages/monitors';
import { formatDateTimeWith, formatNumber, type FormatSettings } from '@/lib/format';

/**
 * Ce que la sonde a vu — les images d'un incident.
 *
 * ── Pourquoi un composant dédié à la comparaison ────────────────────────────
 * Mettre trois vignettes côte à côte serait déjà utile. Ça ne répondrait pas à
 * la question qu'on se pose vraiment devant une panne : **qu'est-ce qui a
 * changé ?** Deux pages presque identiques dont l'une a perdu son panier ou
 * gagné une bannière d'erreur, l'œil ne les départage pas en les regardant l'une
 * après l'autre — il les départage en les superposant.
 *
 * D'où le curseur : les deux images occupent exactement le même rectangle, et
 * on révèle l'une sous l'autre. C'est l'écran le plus utile du lot, et il ne
 * coûte que quelques lignes parce qu'un `clip-path` piloté par un `<input
 * type="range">` suffit — pas de glisser-déposer à la souris, donc utilisable
 * au clavier sans rien ajouter.
 *
 * Les vignettes restent en dessous : la comparaison ne se substitue pas au fait
 * de pouvoir regarder une image en entier, en taille réelle, dans un onglet.
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
 * L'instant d'une capture. Composantes imposées par la vignette, locale prise
 * dans les paramètres d'instance — `settings.locale` tel quel, jamais réduit à
 * deux lettres, et descendu par props pour que le serveur et le client lisent
 * la même valeur.
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
 * Le mégaoctet passe par un formateur de nombres plutôt que par un
 * `replace('.', ',')` : la virgule décimale est une propriété de la locale, pas
 * du français. Et c'est bien la locale de **l'instance** — `fr-FR`, `en-GB` —,
 * pas la langue à deux lettres, pour la raison qui vaut pour les dates.
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

/** Le nom court d'une capture, dans l'ordre où on la regarde. */
function kindLabel(kind: CaptureKind, t: Messages): string {
  if (kind === 'reference') return t('capture.kind.reference');
  if (kind === 'incident_open') return t('capture.kind.incidentOpen');
  return t('capture.kind.incidentResolved');
}

function href(monitorId: string, capture: CaptureView): string {
  return `/api/monitors/${monitorId}/captures/${capture.id}`;
}

/** Une ligne de faits sous une image. Lisible sans regarder l'image. */
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
          {/* Cadrée en haut : le diagnostic d'une page cassée est en haut. */}
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
 * Le comparateur. Deux images dans le même rectangle, un curseur pour révéler.
 *
 * La hauteur commune est la **plus petite des deux** : étirer la plus courte
 * décalerait tout et ferait voir une différence qui n'existe pas. Ce qui dépasse
 * est simplement coupé, et le lien « taille réelle » reste là pour le reste.
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
 * La référence vivante — « voici à quoi ce site ressemble quand il va bien ».
 *
 * Affichée hors de toute chronologie parce qu'elle ne raconte pas un incident :
 * elle est l'étalon auquel le prochain sera comparé. La montrer sert aussi à
 * prouver, sur une sonde qui n'est jamais tombée, que la capture fonctionne —
 * sans quoi la fonctionnalité resterait invisible jusqu'à la première panne.
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
