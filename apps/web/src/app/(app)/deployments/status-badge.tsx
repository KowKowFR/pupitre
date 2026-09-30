'use client';

import { Check, Minus, X } from 'lucide-react';
import type { DeploymentStatus, StepStatus } from '@pupitre/core';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Led } from '@/components/instrument';
import { useT } from '@/i18n/client';
import { deployments as messages } from '@/i18n/messages/deployments';
import { formatDateTimeWith, type FormatSettings } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Les six libellés de statut, dans la langue de l'instance.
 *
 * Un hook remplace la table figée d'avant : celle-ci se construisait au
 * chargement du module, donc avant qu'aucun contexte de langue n'existe. C'est
 * aussi ce qui fait passer ce fichier côté client — le badge est déjà rendu
 * dans des composants clients, et le tableau de bord peut l'afficher tel quel.
 */
export function useDeploymentLabels(): Record<DeploymentStatus, string> {
  const t = useT(messages);
  return {
    pending: t('status.pending'),
    running: t('status.running'),
    success: t('status.success'),
    failed: t('status.failed'),
    rolled_back: t('status.rolled_back'),
    destroyed: t('status.destroyed'),
  };
}

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
  const label = useDeploymentLabels();
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
                  ? 'accent'
                  : 'idle'
        }
        pulse={status === 'running'}
        className="size-2"
      />
      <span className={cn(live && 'font-medium')}>{label[status]}</span>
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
  const t = useT(messages);
  const base = 'inline-flex size-[1.125rem] shrink-0 items-center justify-center rounded-full';

  if (status === 'running') {
    return (
      <span aria-label={t('step.running')} className={cn(base, 'relative', className)}>
        <span className="absolute inset-0 rounded-full border-2 border-accent/25" />
        <span className="absolute inset-0 animate-spin rounded-full border-2 border-accent border-t-transparent border-r-transparent" />
      </span>
    );
  }

  if (status === 'success') {
    return (
      <span aria-label={t('step.success')} className={cn(base, 'bg-ok text-white', className)}>
        <Check className="size-3" strokeWidth={3.5} />
      </span>
    );
  }

  if (status === 'failed') {
    return (
      <span aria-label={t('step.failed')} className={cn(base, 'bg-danger text-white', className)}>
        <X className="size-3" strokeWidth={3.5} />
      </span>
    );
  }

  if (status === 'skipped') {
    return (
      <span
        aria-label={t('step.skipped')}
        className={cn(base, 'border border-dashed border-border-strong text-text-3', className)}
      >
        <Minus className="size-3" strokeWidth={3} />
      </span>
    );
  }

  return (
    <span
      aria-label={t('step.pending')}
      className={cn(base, 'border-2 border-border-strong bg-transparent', className)}
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

/**
 * L'horodatage d'un déploiement.
 *
 * Le fuseau reste **UTC**, et délibérément : ces colonnes se comparent à des
 * logs de worker, qui sont en UTC. La locale, elle, n'avait aucune raison de
 * rester figée — `15/01/2026 14:32:07` sur un panel anglais était une date
 * qu'on lit de travers. Elle vient donc des paramètres d'instance, par props,
 * ce qui garantit aussi la même chaîne côté serveur et côté client.
 */
export function formatDate(iso: string | null, format: FormatSettings): string {
  return formatDateTimeWith(iso, format, {
    dateStyle: 'short',
    timeStyle: 'medium',
    timeZone: 'UTC',
  });
}
