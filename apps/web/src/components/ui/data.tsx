import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Petites formes de données du kit : liste terme/valeur, barre de progression,
 * mini-jauge, avatar. Toutes se lisent sans couleur — un pourcentage est
 * toujours écrit à côté de sa barre.
 */

/** Liste terme/valeur : le terme en gris à gauche, la valeur alignée à droite. */
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

/** Champ en lecture : légende grise au-dessus, valeur dessous. */
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
 * Barre de progression — outremer, parce qu'une progression est « en cours ».
 * Sans valeur, elle devient indéterminée.
 */
export function Progress({
  value,
  label,
  className,
  height,
}: {
  /** 0 à 100 ; `null` pour une progression indéterminée. */
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
 * Mini-jauge d'une ressource (« mém ▬ 62 % ») : graphite au repos, ambre ou
 * rouge au-delà d'un seuil. Le chiffre est toujours écrit.
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

/** Initiales d'une personne, dans un disque graphite. */
export function Avatar({
  name,
  large = false,
  className,
}: {
  name: string;
  large?: boolean;
  className?: string;
}) {
  return (
    <span aria-hidden className={cn('av', large && 'av-lg', className)}>
      {initialsOf(name)}
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
