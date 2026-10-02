'use client';

import type { ReactNode } from 'react';
import type { HostMetrics, Translate } from '@pupitre/core';
import { Led, Readout, ReadoutBar, type Tone } from '@/components/instrument';
import { Alert } from '@/components/ui/alert';
import { useT } from '@/i18n/client';
import { servers } from '@/i18n/messages/servers';
import { withSlot } from '@/lib/rich';
import {
  toneFor,
  trendText,
  type HistoryMetric,
  type MetricSummaryView,
  type ThresholdView,
} from './host-history';
import type { MetricsEntry } from './use-host-metrics';

/**
 * Les métriques d'un serveur, lisibles d'un coup d'œil.
 *
 * Trois principes :
 *
 * 1. **Rien en octets bruts seuls.** « 3,2 Gio libres » ne dit rien sans le
 *    total ; une charge de 4 ne dit rien sans le nombre de cœurs. Chaque relevé
 *    est donc rendu en proportion — un pourcentage — et le chiffre absolu vient
 *    en dessous, pour qui veut le détail.
 * 2. **Inconnu n'est pas zéro.** Une métrique absente affiche « inconnu ». Un
 *    zéro laisserait croire à un disque vide ou à une machine au repos, ce qui
 *    est exactement l'inverse d'une information.
 * 3. **L'état se lit à la forme.** Le voyant d'une case porte son ton par son
 *    halo, et la tendance est écrite en toutes lettres : la lecture survit au
 *    daltonisme et à une capture en niveaux de gris.
 */

type T = Translate<typeof servers.fr>;

/**
 * Kio → Gio. Deux divisions par 1024, donc bien des **gibioctets** : l'anglais
 * dit `GiB`, pas `GB`. Une unité qui ment sur sa base fait douter du chiffre.
 */
function gib(kb: number): string {
  return (kb / 1024 / 1024).toFixed(kb / 1024 / 1024 < 10 ? 1 : 0);
}

function formatUptime(seconds: number | null, t: T): string {
  if (seconds === null) return t('unknown');
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return t('uptime.days', { days, hours });
  if (hours > 0) return t('uptime.hours', { hours, minutes });
  return t('uptime.minutes', { minutes });
}

/**
 * Seuils **par défaut** de l'affichage, quand aucun n'a encore été résolu pour
 * la machine — le tout premier rendu d'une cible qui n'a jamais été relevée.
 * Les vraies valeurs viennent de la base ; celles-ci sont les mêmes, en dur,
 * pour que l'écran ne change pas de couleur entre deux chargements.
 */
const FALLBACK_THRESHOLDS: Record<HistoryMetric, ThresholdView> = {
  disk: { limitPercent: 90, enabled: true, origin: 'default' },
  memory: { limitPercent: 90, enabled: true, origin: 'default' },
  load: { limitPercent: 100, enabled: true, origin: 'default' },
};

/** La bande, sur le fond en retrait de la carte, juste sous son en-tête. */
function Band({ children }: { children: ReactNode }) {
  return <div className="bg-bg-subtle">{children}</div>;
}

/** Une valeur manquante : écrite, en gris — jamais un zéro. */
function Unknown({ t }: { t: T }) {
  return <span className="text-text-3">{t('unknown')}</span>;
}

/** Les quatre cases pendant le relevé : la silhouette exacte de ce qui arrive. */
function Pending({ t }: { t: T }) {
  const labels = [t('metric.load'), t('metric.memory'), t('metric.disk'), t('metric.uptime')];
  return (
    <>
      <span role="status" className="sr-only">
        {t('readout.pending')}
      </span>
      <ReadoutBar bare compact>
        {labels.map((label) => (
          <Readout
            key={label}
            label={label}
            tone="accent"
            pulse
            value={<span aria-hidden className="sk inline-block h-[22px] w-14 align-middle" />}
            hint={<span aria-hidden className="sk sk-t inline-block w-28" />}
          />
        ))}
      </ReadoutBar>
    </>
  );
}

export function HostReadouts({
  entry,
  enabled,
  thresholds = FALLBACK_THRESHOLDS,
  summary,
}: {
  entry: MetricsEntry | undefined;
  enabled: boolean;
  /**
   * Les seuils de **cette** machine. C'est eux qui décident du rouge, et ce sont
   * exactement ceux qui décident de l'alerte : une seule valeur de référence
   * pour la couleur et pour le journal, au lieu de deux qui pouvaient diverger.
   */
  thresholds?: Record<HistoryMetric, ThresholdView>;
  /** La fenêtre d'historique, d'où vient la tendance affichée à droite de chaque case. */
  summary?: Record<HistoryMetric, MetricSummaryView>;
}) {
  const t = useT(servers);

  if (!enabled) {
    return (
      <Band>
        <p className="t-sm flex items-center gap-2 px-4 py-3 text-text-2">
          <Led tone="idle" />
          <span className="min-w-0">{t('readout.restricted')}</span>
        </p>
      </Band>
    );
  }

  if (entry === undefined || entry.state === 'loading') {
    return (
      <Band>
        <Pending t={t} />
      </Band>
    );
  }

  if (entry.state === 'error') {
    return (
      <Band>
        <div className="px-4 py-3">
          <Alert variant="destructive">{t('readout.failed', { message: entry.message })}</Alert>
        </div>
      </Band>
    );
  }

  const metrics: HostMetrics = entry.metrics;

  if (!metrics.reachable) {
    return (
      <Band>
        <div className="px-4 py-3">
          <Alert variant="destructive">
            {withSlot(
              (reason) => t('readout.unreachable', { reason }),
              <span className="mono">{metrics.error ?? t('readout.unreachable.reason')}</span>,
            )}
          </Alert>
        </div>
      </Band>
    );
  }

  const { load, memory, disk } = metrics;
  const trend = (metric: HistoryMetric) =>
    summary ? trendText(summary[metric].trend, t) : undefined;
  const tone = (metric: HistoryMetric, value: number | null): Tone =>
    toneFor(value, thresholds[metric].limitPercent, thresholds[metric].enabled);

  // La charge n'a de sens que rapportée aux cœurs : sans `nproc`, on affiche le
  // nombre brut et on dit franchement qu'on ne sait pas diviser.
  const perCore = load?.perCore === null || load?.perCore === undefined ? null : load.perCore * 100;

  return (
    <Band>
      <ReadoutBar bare compact>
        <Readout
          label={t('metric.load')}
          tone={tone('load', perCore)}
          aside={trend('load')}
          value={
            load === null ? (
              <Unknown t={t} />
            ) : perCore === null ? (
              load.one.toFixed(2)
            ) : (
              Math.round(perCore)
            )
          }
          unit={perCore === null ? undefined : '%'}
          hint={
            load === null
              ? t('load.noSource')
              : load.cores === null
                ? t('load.noCores', {
                    five: load.five.toFixed(2),
                    fifteen: load.fifteen.toFixed(2),
                  })
                : t('load.perCore', { percent: Math.round(perCore ?? 0), count: load.cores })
          }
        />

        <Readout
          label={t('metric.memory')}
          tone={tone('memory', memory?.usedPercent ?? null)}
          aside={trend('memory')}
          value={memory === null ? <Unknown t={t} /> : Math.round(memory.usedPercent)}
          unit={memory === null ? undefined : '%'}
          hint={
            memory === null
              ? t('memory.noSource')
              : t('memory.used', { used: gib(memory.usedKb), total: gib(memory.totalKb) })
          }
        />

        <Readout
          label={t('metric.disk')}
          tone={tone('disk', disk?.usePercent ?? null)}
          aside={trend('disk')}
          value={disk === null ? <Unknown t={t} /> : disk.usePercent}
          unit={disk === null ? undefined : '%'}
          hint={
            disk === null
              ? t('disk.noSource')
              : t('disk.free', { free: gib(disk.availableKb), path: disk.path })
          }
        />

        <Readout
          label={t('metric.uptime')}
          tone={metrics.uptimeSeconds === null ? 'idle' : 'ok'}
          value={
            metrics.uptimeSeconds === null ? (
              <Unknown t={t} />
            ) : (
              formatUptime(metrics.uptimeSeconds, t)
            )
          }
          hint={metrics.os.prettyName ?? metrics.os.kernel ?? t('os.unknown')}
        />
      </ReadoutBar>
    </Band>
  );
}
