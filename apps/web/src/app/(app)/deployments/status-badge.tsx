import { Check, Minus, X } from 'lucide-react';
import type { DeploymentStatus, StepStatus } from '@pupitre/core';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Led } from '@/components/instrument';
import { cn } from '@/lib/utils';

export const DEPLOYMENT_LABEL: Record<DeploymentStatus, string> = {
  pending: 'en attente',
  running: 'en cours',
  success: 'réussi',
  failed: 'échoué',
  rolled_back: 'rollback effectué',
  destroyed: 'détruit',
};

/**
 * `rolled_back` n'est pas `failed`.
 *
 * Un déploiement rollbacké est un déploiement qui a raté **et dont on s'est
 * remis** : l'URL répond, la version précédente est en service. Le peindre en
 * rouge ferait croire à une panne là où le filet de sécurité a fonctionné.
 * D'où l'ambre : quelque chose s'est mal passé, rien n'est cassé.
 */
const DEPLOYMENT_VARIANT: Record<DeploymentStatus, BadgeProps['variant']> = {
  pending: 'secondary',
  running: 'default',
  success: 'ok',
  failed: 'destructive',
  rolled_back: 'warn',
  destroyed: 'outline',
};

export function DeploymentStatusBadge({ status }: { status: DeploymentStatus }) {
  const live = status === 'running' || status === 'pending';

  return (
    <Badge variant={DEPLOYMENT_VARIANT[status]} className="gap-1.5 px-2">
      <Led
        tone={
          status === 'success'
            ? 'ok'
            : status === 'failed'
              ? 'danger'
              : status === 'rolled_back'
                ? 'warn'
                : status === 'running'
                  ? 'signal'
                  : 'idle'
        }
        pulse={status === 'running'}
        className="size-2"
      />
      <span className={cn(live && 'font-medium')}>{DEPLOYMENT_LABEL[status]}</span>
    </Badge>
  );
}

/**
 * Pastille d'état d'une étape.
 *
 * Cinq états, cinq formes distinctes — anneau vide, arc en rotation, coche,
 * croix, tiret. La couleur double la forme sans jamais la remplacer : le
 * pipeline reste lisible en niveaux de gris comme sous `prefers-reduced-motion`,
 * où l'arc s'immobilise mais reste un arc.
 */
export function StepIcon({ status, className }: { status: StepStatus; className?: string }) {
  const base = 'inline-flex size-[1.125rem] shrink-0 items-center justify-center rounded-full';

  if (status === 'running') {
    return (
      <span aria-label="en cours" className={cn(base, 'relative', className)}>
        <span className="absolute inset-0 rounded-full border-2 border-signal/25" />
        <span className="absolute inset-0 animate-spin rounded-full border-2 border-signal border-t-transparent border-r-transparent" />
      </span>
    );
  }

  if (status === 'success') {
    return (
      <span aria-label="réussie" className={cn(base, 'bg-ok text-white', className)}>
        <Check className="size-3" strokeWidth={3.5} />
      </span>
    );
  }

  if (status === 'failed') {
    return (
      <span aria-label="échouée" className={cn(base, 'bg-danger text-white', className)}>
        <X className="size-3" strokeWidth={3.5} />
      </span>
    );
  }

  if (status === 'skipped') {
    return (
      <span
        aria-label="sans objet"
        className={cn(base, 'border border-dashed border-line-strong text-ink-faint', className)}
      >
        <Minus className="size-3" strokeWidth={3} />
      </span>
    );
  }

  return (
    <span
      aria-label="en attente"
      className={cn(base, 'border-2 border-line-strong bg-transparent', className)}
    />
  );
}

export function formatDuration(from: string | null, to: string | null): string {
  if (!from) return '—';
  const end = to ? new Date(to).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - new Date(from).getTime()) / 1000));
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'short',
    timeStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(iso));
}
