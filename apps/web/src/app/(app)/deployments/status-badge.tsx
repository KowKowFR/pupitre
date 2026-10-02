'use client';

import type { DeploymentStatus } from '@pupitre/core';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { useT } from '@/i18n/client';
import { deployments as messages } from '@/i18n/messages/deployments';
import { formatDateTimeWith, type FormatSettings } from '@/lib/format';

/**
 * Les six libellés de statut, dans la langue de l'instance.
 *
 * Un hook remplace la table figée d'avant : celle-ci se construisait au
 * chargement du module, donc avant qu'aucun contexte de langue n'existe. C'est
 * aussi ce qui fait passer ce fichier côté client — le badge est déjà rendu
 * dans des composants clients, et le tableau de bord peut l'afficher tel quel.
 */
function useDeploymentLabels(): Record<DeploymentStatus, string> {
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
  pending: 'idle',
  running: 'accent',
  success: 'ok',
  failed: 'danger',
  rolled_back: 'warn',
  destroyed: 'outline',
};

/**
 * Pastille de statut d'un run : un point et un mot, dans le ton de l'état.
 * « En cours » est en outremer — ce qui est en train de se faire.
 */
export function DeploymentStatusBadge({ status }: { status: DeploymentStatus }) {
  const label = useDeploymentLabels();
  return (
    <Badge variant={DEPLOYMENT_VARIANT[status]} dot>
      {label[status]}
    </Badge>
  );
}

/**
 * Durée d'un run. En cours, elle se compte jusqu'à maintenant — et le serveur
 * et le navigateur ne lisent pas l'horloge à la même seconde : là où elle
 * s'affiche, l'élément porte `suppressHydrationWarning`.
 */
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
