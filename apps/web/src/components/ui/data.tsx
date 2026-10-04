import * as React from 'react';
import { avatarSrc } from '@pupitre/core';
import { cn } from '@/lib/utils';

/**
 * The kit's small data shapes: term/value list, progress bar, mini gauge,
 * avatar. All of them read without color — a percentage is always written next
 * to its bar.
 */

/** A term/value list: the term in gray on the left, the value aligned on the right. */
export function KeyValue({
  items,
  className,
}: {
  items: ReadonlyArray<{ term: React.ReactNode; value: React.ReactNode; key?: string }>;
  className?: string;
}) {
  return (
    <dl className={cn('kv', className)}>
      {items.map((item, index) => (
        <React.Fragment key={item.key ?? index}>
          <dt>{item.term}</dt>
          <dd>{item.value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/** A read-only field: gray caption above, value below. */
export function FieldValue({
  label,
  children,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="fg">
      <span>{label}</span>
      <span>{children}</span>
    </div>
  );
}

/**
 * A progress bar — ultramarine, because a progress is "in progress". Without a
 * value, it becomes indeterminate.
 */
export function Progress({
  value,
  label,
  className,
  height,
}: {
  /** 0 to 100; `null` for an indeterminate progress. */
  value: number | null;
  label: string;
  className?: string;
  height?: number;
}) {
  const clamped = value === null ? null : Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped ?? undefined}
      className={cn('progress', clamped === null && 'is-indet', className)}
      style={height ? { height } : undefined}
    >
      <span style={clamped === null ? undefined : { width: `${clamped}%` }} />
    </div>
  );
}

/**
 * A resource's mini gauge ("mem ▬ 62%"): graphite at rest, amber or red beyond a
 * threshold. The figure is always written.
 */
export function MiniGauge({
  label,
  percent,
  tone,
  title,
}: {
  label: React.ReactNode;
  percent: number;
  tone?: 'warn' | 'danger';
  title?: string;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <span
      className={cn('mgauge', tone === 'warn' && 'is-warn', tone === 'danger' && 'is-danger')}
      title={title}
    >
      {label}
      <i aria-hidden>
        <b style={{ width: `${clamped}%` }} />
      </i>
      <span className="num">{Math.round(clamped)}%</span>
    </span>
  );
}

/**
 * A person: their profile picture, or their initials in a graphite disc. Only a
 * URL the panel wrote itself is shown (`avatarSrc`) — never an image hosted
 * elsewhere.
 */
export function Avatar({
  name,
  src,
  large = false,
  className,
}: {
  name: string;
  src?: string | null;
  large?: boolean;
  className?: string;
}) {
  const image = avatarSrc(src);
  return (
    <span aria-hidden className={cn('av', large && 'av-lg', image && 'has-img', className)}>
      {image ? (
        // An authenticated and versioned API URL: `next/image` would bring nothing.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={image} alt="" loading="lazy" decoding="async" draggable={false} />
      ) : (
        initialsOf(name)
      )}
    </span>
  );
}

export function initialsOf(name: string): string {
  const parts = name
    .trim()
    .split(/[\s@._-]+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : (parts[0]?.[1] ?? '');
  return (first + last).toUpperCase();
}
