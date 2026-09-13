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
import { CAPTURE_KIND_SHORT, type CaptureKind } from '@pupitre/core';
import { Badge } from '@/components/ui/badge';

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

function formatClock(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} Mo`;
}

function href(monitorId: string, capture: CaptureView): string {
  return `/api/monitors/${monitorId}/captures/${capture.id}`;
}

/** Une ligne de faits sous une image. Lisible sans regarder l'image. */
function CaptureFacts({ capture }: { capture: CaptureView }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[0.6875rem] text-ink-muted">
      <span className="font-mono">{formatClock(capture.takenAt)}</span>
      {capture.httpStatus === null ? null : (
        <Badge variant="outline">code {capture.httpStatus}</Badge>
      )}
      <span className="font-mono">
        {capture.width}×{capture.height} · {formatBytes(capture.bytes)}
      </span>
      {capture.truncated ? (
        <Badge variant="secondary" title="La page était plus haute que la borne de rendu.">
          page tronquée
        </Badge>
      ) : null}
    </div>
  );
}

function CaptureThumb({ monitorId, capture }: { monitorId: string; capture: CaptureView }) {
  return (
    <figure className="min-w-0 space-y-1.5">
      <figcaption className="eyebrow text-ink-faint">{CAPTURE_KIND_SHORT[capture.kind]}</figcaption>
      {capture.hasImage ? (
        <a
          href={href(monitorId, capture)}
          target="_blank"
          rel="noreferrer"
          className="block overflow-hidden rounded border"
          style={{ borderColor: 'var(--line)' }}
          title="Ouvrir l'image en taille réelle"
        >
          {/* Cadrée en haut : le diagnostic d'une page cassée est en haut. */}
          <img
            src={href(monitorId, capture)}
            alt={`Capture « ${CAPTURE_KIND_SHORT[capture.kind]} » du ${formatClock(capture.takenAt)}`}
            loading="lazy"
            className="h-40 w-full bg-white object-cover object-top"
          />
        </a>
      ) : (
        <div
          className="flex h-40 items-center justify-center rounded border px-3 text-center text-xs text-ink-muted"
          style={{ borderColor: 'var(--line)' }}
        >
          Image reprise par la rétention
          {capture.purgedAt ? ` le ${formatClock(capture.purgedAt)}` : null}. La capture a bien eu
          lieu — {formatBytes(capture.bytes)}.
        </div>
      )}
      <CaptureFacts capture={capture} />
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
}: {
  monitorId: string;
  before: CaptureView;
  after: CaptureView;
}) {
  const [position, setPosition] = React.useState(50);
  const height = Math.min(before.height, after.height);

  return (
    <div className="space-y-2">
      <div
        className="relative w-full overflow-hidden rounded border bg-white"
        style={{ borderColor: 'var(--line)', aspectRatio: `${before.width} / ${height}` }}
      >
        <img
          src={href(monitorId, after)}
          alt={`Page pendant l'incident, ${formatClock(after.takenAt)}`}
          className="absolute inset-0 h-full w-full object-cover object-top"
        />
        <img
          src={href(monitorId, before)}
          alt={`Page avant l'incident, ${formatClock(before.takenAt)}`}
          className="absolute inset-0 h-full w-full object-cover object-top"
          style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
        />
        <div
          className="pointer-events-none absolute top-0 bottom-0 w-px"
          style={{ left: `${position}%`, background: 'var(--danger)' }}
        />
        <span className="absolute top-1 left-1 rounded bg-black/70 px-1.5 py-0.5 text-[0.625rem] text-white">
          avant — {formatClock(before.takenAt)}
        </span>
        <span className="absolute top-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[0.625rem] text-white">
          pendant — {formatClock(after.takenAt)}
        </span>
      </div>
      <label className="flex items-center gap-3 text-xs text-ink-muted">
        <span className="shrink-0">Révéler l&apos;avant</span>
        <input
          type="range"
          min={0}
          max={100}
          value={position}
          onChange={(event) => setPosition(Number(event.target.value))}
          className="w-full"
          aria-label="Position du comparateur entre la page avant l'incident et pendant l'incident"
        />
        <span className="w-10 shrink-0 text-right font-mono">{position} %</span>
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
}: {
  monitorId: string;
  capture: CaptureView | null;
}) {
  if (capture === null) return null;
  return (
    <div className="rounded border p-3" style={{ borderColor: 'var(--line)' }}>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="eyebrow text-ink-faint">Référence visuelle</span>
        <span className="text-xs text-ink-muted">
          La page telle qu&apos;elle était la dernière fois que tout allait bien. C&apos;est le
          « avant » auquel le prochain incident sera comparé.
        </span>
      </div>
      <div className="max-w-md">
        <CaptureThumb monitorId={monitorId} capture={capture} />
      </div>
    </div>
  );
}

/**
 * Le bloc affiché sous un incident.
 *
 * Ne rend **rien** quand il n'y a aucune capture : une instance sans navigateur
 * de capture ne doit pas voir apparaître un encart vide qui l'accuse de quelque
 * chose. L'absence de capture n'est pas un défaut.
 */
export function IncidentCaptures({
  monitorId,
  captures,
}: {
  monitorId: string;
  captures: CaptureView[];
}) {
  if (captures.length === 0) return null;

  const before = captures.find((capture) => capture.kind === 'reference') ?? null;
  const during = captures.find((capture) => capture.kind === 'incident_open') ?? null;
  const after = captures.find((capture) => capture.kind === 'incident_resolved') ?? null;
  const ordered = [before, during, after].filter((capture): capture is CaptureView => capture !== null);

  const comparable = before !== null && during !== null && before.hasImage && during.hasImage;

  return (
    <div className="mt-2 space-y-3 rounded border p-3" style={{ borderColor: 'var(--line)' }}>
      <div className="eyebrow text-ink-faint">Ce que la sonde a vu</div>

      {comparable ? (
        <CaptureSlider monitorId={monitorId} before={before} after={during} />
      ) : (
        <p className="text-xs text-ink-muted">
          {before === null
            ? "Pas d'image de référence pour cet incident : la sonde n'avait pas encore été photographiée en bon état. La comparaison avant/après apparaîtra au prochain."
            : "Il manque une des deux images : la comparaison n'est pas possible."}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        {ordered.map((capture) => (
          <CaptureThumb key={capture.id} monitorId={monitorId} capture={capture} />
        ))}
      </div>
    </div>
  );
}
