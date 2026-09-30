import type { RuntimesAvailable, TargetHealth } from '@pupitre/core';
import { RuntimePill } from '@/components/ui/badge';
import { State } from '@/components/ui/led';
import { formatDateTime, type DateInput, type FormatSettings } from '@/lib/format';
import { STATUS_TONE } from './status';

/**
 * Les deux runtimes d'une cible, présents ou non. K3s ne compte comme
 * disponible que si le cluster est prêt : un binaire sans nœud prêt ne
 * déploie rien.
 */
export function RuntimeBadges({ runtimes }: { runtimes: RuntimesAvailable }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <RuntimePill name="Docker" available={runtimes.docker.available} version={runtimes.docker.version} />
      <RuntimePill
        name="K3s"
        available={runtimes.k3s.available && runtimes.k3s.clusterReady}
        version={runtimes.k3s.version}
      />
    </span>
  );
}

/** L'état d'une cible : un voyant et son libellé, jamais la couleur seule. */
export function StatusBadge({ status, label }: { status: TargetHealth; label: string }) {
  return <State tone={STATUS_TONE[status]}>{label}</State>;
}

export function formatPreflightDate(iso: DateInput, format: FormatSettings, never: string): string {
  return formatDateTime(iso, format, never);
}
