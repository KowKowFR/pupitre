import type { RuntimesAvailable, TargetHealth } from '@tp/core';
import { Led } from '@/components/instrument';
import { Badge } from '@/components/ui/badge';
import { formatDateTime, type DateInput, type FormatSettings } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * « Docker 27.x » avec voyant vert, « K3s » éteint — la lecture de la liste
 * doit tenir en un coup d'œil. Le voyant porte la disponibilité, la version
 * reste en chasse fixe à côté.
 */
function RuntimePill({
  name,
  available,
  version,
}: {
  name: string;
  available: boolean;
  version: string | null;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 font-mono text-[0.6875rem] leading-4',
        available ? 'border-ok-edge bg-ok-soft/60 text-ink' : 'border-line text-ink-faint',
      )}
    >
      <Led tone={available ? 'ok' : 'idle'} className="size-2" />
      {name}
      {available && version ? <span className="text-ink-muted">{version}</span> : null}
    </span>
  );
}

export function RuntimeBadges({ runtimes }: { runtimes: RuntimesAvailable }) {
  const docker = runtimes.docker;
  const k3s = runtimes.k3s;
  const k3sUp = k3s.available && k3s.clusterReady;

  return (
    <div className="flex flex-wrap gap-1.5">
      <RuntimePill name="Docker" available={docker.available} version={docker.version ?? null} />
      <RuntimePill name="K3s" available={k3sUp} version={k3s.version ?? null} />
    </div>
  );
}

const STATUS_LABEL: Record<TargetHealth, string> = {
  unknown: 'jamais testée',
  ok: 'opérationnelle',
  degraded: 'dégradée',
  unreachable: 'injoignable',
};

const STATUS_VARIANT = {
  unknown: 'outline',
  ok: 'ok',
  degraded: 'warn',
  unreachable: 'destructive',
} as const;

export function StatusBadge({ status }: { status: TargetHealth }) {
  return <Badge variant={STATUS_VARIANT[status]}>{STATUS_LABEL[status]}</Badge>;
}

/**
 * Formatage confié au helper partagé : le fuseau et la locale viennent des
 * paramètres d'instance, pas d'un `Intl.DateTimeFormat` recopié dans chaque
 * table. « jamais » reste le repli propre à une cible jamais testée.
 */
export function formatPreflightDate(iso: DateInput, format: FormatSettings): string {
  return formatDateTime(iso, format, 'jamais');
}
