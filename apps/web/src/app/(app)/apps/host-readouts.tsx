'use client';

import type { ReactNode } from 'react';
import type { HostMetrics } from '@pupitre/core';
import { Led, type Tone } from '@/components/instrument';
import { cn } from '@/lib/utils';
import type { MetricsEntry } from './use-host-metrics';

/**
 * Les métriques d'un serveur, lisibles d'un coup d'œil.
 *
 * Trois principes :
 *
 * 1. **Rien en octets bruts seuls.** « 3,2 Gio libres » ne dit rien sans le
 *    total ; une charge de 4 ne dit rien sans le nombre de cœurs. Chaque relevé
 *    est donc rendu en proportion — une jauge — et le chiffre absolu vient en
 *    dessous, pour qui veut le détail.
 * 2. **Inconnu n'est pas zéro.** Une métrique absente affiche « inconnu » et
 *    aucune jauge. Un zéro laisserait croire à un disque vide ou à une machine
 *    au repos, ce qui est exactement l'inverse d'une information.
 * 3. **L'état se lit à la forme.** La jauge porte la proportion par sa
 *    longueur, le voyant par son halo : la lecture survit au daltonisme et à
 *    une capture en niveaux de gris.
 */

function gib(kb: number): string {
  return (kb / 1024 / 1024).toFixed(kb / 1024 / 1024 < 10 ? 1 : 0);
}

export function formatUptime(seconds: number | null): string {
  if (seconds === null) return 'inconnu';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} j ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  return `${minutes} min`;
}

/** Seuils communs à la mémoire et au disque. En proportion, jamais en octets. */
function saturationTone(percent: number): Tone {
  if (percent >= 90) return 'danger';
  if (percent >= 75) return 'warn';
  return 'ok';
}

/**
 * Jauge de proportion. La longueur porte l'information ; la couleur ne fait que
 * la confirmer. `aria-hidden` parce que le chiffre est écrit juste à côté :
 * l'annoncer deux fois n'aide personne.
 */
function Gauge({ ratio, tone }: { ratio: number; tone: Tone }) {
  const fill = Math.min(100, Math.max(2, Math.round(ratio * 100)));
  const bar: Record<Tone, string> = {
    ok: 'bg-ok',
    warn: 'bg-warn',
    danger: 'bg-danger',
    signal: 'bg-signal',
    idle: 'bg-ink-faint',
  };

  return (
    <span aria-hidden className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-surface-3">
      <span className={cn('block h-full rounded-full', bar[tone])} style={{ width: `${fill}%` }} />
    </span>
  );
}

function Metric({
  label,
  value,
  hint,
  ratio,
  tone,
  unknown = false,
}: {
  label: string;
  value: string;
  hint: string;
  /** `null` : pas de jauge — soit la mesure manque, soit elle n'a pas de plafond. */
  ratio: number | null;
  tone: Tone;
  /** La mesure n'a pas pu être prise. Grise la valeur, qui dit « inconnu ». */
  unknown?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col justify-start px-3 py-2">
      <span className="eyebrow flex items-center gap-1.5 truncate text-ink-faint">
        <Led tone={tone} className="size-2" />
        {label}
      </span>
      <span
        className={cn(
          'mt-1 truncate font-mono text-[0.9375rem] leading-none font-medium tabular-nums',
          unknown ? 'text-ink-faint' : 'text-ink',
        )}
      >
        {value}
      </span>
      {ratio === null ? null : <Gauge ratio={ratio} tone={tone} />}
      <span className="mt-1 truncate text-[0.6875rem] leading-tight text-ink-faint">{hint}</span>
    </div>
  );
}

/** Quatre cases de la même taille, quelle que soit la métrique manquante. */
function Strip({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-x-2 gap-y-1 divide-line sm:grid-cols-4 sm:divide-x">
      {children}
    </div>
  );
}

function Placeholder({ message, tone }: { message: string; tone: Tone }) {
  return (
    <div className="flex items-center gap-2 px-3 py-3 text-[0.75rem] text-ink-muted">
      <Led tone={tone} pulse={tone === 'signal'} />
      <span className="min-w-0 truncate">{message}</span>
    </div>
  );
}

export function HostReadouts({ entry, enabled }: { entry: MetricsEntry | undefined; enabled: boolean }) {
  if (!enabled) {
    return (
      <Placeholder
        tone="idle"
        message="Relevé indisponible — la permission « target:read » est requise pour interroger la machine."
      />
    );
  }

  if (entry === undefined || entry.state === 'loading') {
    return <Placeholder tone="signal" message="Relevé en cours…" />;
  }

  if (entry.state === 'error') {
    return <Placeholder tone="danger" message={`Relevé impossible — ${entry.message}`} />;
  }

  const metrics: HostMetrics = entry.metrics;

  if (!metrics.reachable) {
    return (
      <Placeholder
        tone="danger"
        message={`Machine injoignable — ${metrics.error ?? 'raison inconnue'}`}
      />
    );
  }

  const { load, memory, disk } = metrics;

  const loadTone: Tone =
    load === null || load.perCore === null
      ? 'idle'
      : load.perCore >= 1
        ? 'danger'
        : load.perCore >= 0.7
          ? 'warn'
          : 'ok';

  return (
    <Strip>
      <Metric
        label="Charge"
        tone={loadTone}
        value={load === null ? 'inconnu' : load.one.toFixed(2)}
        unknown={load === null}
        // La charge n'a de sens que rapportée aux cœurs : sans `nproc`, on
        // affiche le nombre brut et on dit franchement qu'on ne sait pas diviser.
        ratio={load?.perCore ?? null}
        hint={
          load === null
            ? 'aucun /proc/loadavg'
            : load.cores === null
              ? `${load.five.toFixed(2)} · ${load.fifteen.toFixed(2)} — cœurs inconnus`
              : `${Math.round((load.perCore ?? 0) * 100)} % de ${load.cores} cœur${load.cores > 1 ? 's' : ''}`
        }
      />

      <Metric
        label="Mémoire"
        tone={memory === null ? 'idle' : saturationTone(memory.usedPercent)}
        value={memory === null ? 'inconnu' : `${Math.round(memory.usedPercent)} %`}
        unknown={memory === null}
        ratio={memory === null ? null : memory.usedPercent / 100}
        hint={
          memory === null
            ? 'aucun MemAvailable'
            : `${gib(memory.usedKb)} / ${gib(memory.totalKb)} Gio utilisés`
        }
      />

      <Metric
        label="Disque"
        tone={disk === null ? 'idle' : saturationTone(disk.usePercent)}
        value={disk === null ? 'inconnu' : `${disk.usePercent} %`}
        unknown={disk === null}
        ratio={disk === null ? null : disk.usePercent / 100}
        hint={
          disk === null
            ? 'aucun df exploitable'
            : `${gib(disk.availableKb)} Gio libres · ${disk.path}`
        }
      />

      <Metric
        label="Uptime"
        tone={metrics.uptimeSeconds === null ? 'idle' : 'ok'}
        value={formatUptime(metrics.uptimeSeconds)}
        unknown={metrics.uptimeSeconds === null}
        ratio={null}
        hint={metrics.os.prettyName ?? metrics.os.kernel ?? 'système inconnu'}
      />
    </Strip>
  );
}
