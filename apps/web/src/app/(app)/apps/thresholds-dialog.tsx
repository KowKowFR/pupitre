'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Gauge } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { servers } from '@/i18n/messages/servers';
import { toast } from '@/lib/toast';
import type { HistoryMetric, ThresholdView } from './host-history';

/**
 * Réglage des seuils d'une machine.
 *
 * ── Pourquoi ce bouton existe ───────────────────────────────────────────────
 * Un seuil qu'on ne peut pas régler est un seuil qu'on désactive — mentalement
 * d'abord, puis pour de bon. Le serveur de build qui vit à 95 % de disque doit
 * pouvoir dire « ici, c'est 98 », sinon son exploitant apprend en une semaine à
 * ignorer les alertes de disque. Y compris la vraie.
 *
 * ── Ce que la modale montre, et qui n'est pas décoratif ─────────────────────
 * **D'où vient le seuil affiché** : du panel, du défaut de l'instance, ou de
 * cette machine. Sans cette mention, personne ne sait s'il est en train de
 * changer une valeur ou d'en créer une ; et « Rendre au défaut » n'aurait pas
 * de sens visible.
 *
 * ── Pourquoi pas de champ pour le nombre de relevés consécutifs ─────────────
 * Il existe en base et dans l'API — le catalogue lui donne une valeur pensée par
 * métrique (1 pour le disque, qui ne rebondit pas ; 3 pour la charge, qui n'est
 * que du bruit à l'échelle d'un relevé). Le sortir à l'écran, c'est demander à
 * l'exploitant de trancher une question d'hystérésis qu'il n'a aucune raison de
 * se poser pour changer un pourcentage. Il reste réglable par l'API, qui est le
 * bon endroit pour un réglage rare.
 */

type MessageKey = keyof typeof servers.fr;

const METRIC_KEY: Record<HistoryMetric, MessageKey> = {
  disk: 'metric.disk',
  memory: 'metric.memory',
  load: 'thresholds.metric.load',
};

const METRIC_HINT_KEY: Record<HistoryMetric, MessageKey> = {
  disk: 'thresholds.hint.disk',
  memory: 'thresholds.hint.memory',
  load: 'thresholds.hint.load',
};

const ORIGIN_KEY: Record<ThresholdView['origin'], MessageKey> = {
  default: 'thresholds.origin.default',
  global: 'thresholds.origin.global',
  target: 'thresholds.origin.target',
};

const METRICS: readonly HistoryMetric[] = ['disk', 'memory', 'load'];

type Draft = { limitPercent: string; enabled: boolean };

export function ThresholdsDialog({
  targetId,
  targetName,
  thresholds,
}: {
  targetId: string;
  targetName: string;
  thresholds: Record<HistoryMetric, ThresholdView>;
}) {
  const t = useT(servers);
  const shared = useT(common);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<HistoryMetric, Draft>>(
    () =>
      Object.fromEntries(
        METRICS.map((metric) => [
          metric,
          {
            limitPercent: String(thresholds[metric].limitPercent),
            enabled: thresholds[metric].enabled,
          },
        ]),
      ) as Record<HistoryMetric, Draft>,
  );

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      for (const metric of METRICS) {
        const value = Number(draft[metric].limitPercent);
        if (!Number.isFinite(value) || value <= 0 || value > 1000) {
          setError(t('thresholds.invalid', { metric: t(METRIC_KEY[metric]) }));
          return;
        }
        const response = await fetch('/api/supervision/thresholds', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            targetId,
            metric,
            limitPercent: value,
            enabled: draft[metric].enabled,
          }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as {
            error?: { message?: string };
          };
          setError(body.error?.message ?? t('thresholds.refused', { status: response.status }));
          return;
        }
      }
      setOpen(false);
      toast({
        title: t('thresholds.saved', { name: targetName }),
        description: t('thresholds.saved.detail'),
      });
      // Les seuils décident de la couleur des voyants et du trait de la frise :
      // la page doit se relire pour que l'écran dise la vérité tout de suite.
      router.refresh();
    } catch {
      setError(t('thresholds.unreachable'));
    } finally {
      setBusy(false);
    }
  }, [draft, router, t, targetId, targetName]);

  /** Retire la surcharge de cette machine : la couche du dessous reprend. */
  const reset = useCallback(
    async (metric: HistoryMetric) => {
      setBusy(true);
      setError(null);
      try {
        await fetch(`/api/supervision/thresholds?targetId=${targetId}&metric=${metric}`, {
          method: 'DELETE',
        });
        setOpen(false);
        router.refresh();
      } finally {
        setBusy(false);
      }
    },
    [router, targetId],
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" aria-label={t('thresholds.aria', { name: targetName })}>
          {t('thresholds.button')}
        </Button>
      </DialogTrigger>
      <DialogContent size="wide">
        <DialogHeader icon={<Gauge />} tone="accent">
          <DialogTitle>{t('thresholds.title', { name: targetName })}</DialogTitle>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-3">
          <DialogDescription>{t('thresholds.description')}</DialogDescription>
          {error ? <Alert variant="destructive">{error}</Alert> : null}

          <div>
            {METRICS.map((metric) => (
              <div
                key={metric}
                className="flex flex-wrap items-center gap-3 border-t border-border-subtle py-2.5"
              >
                <Checkbox
                  aria-label={t('thresholds.watch.aria', { metric: t(METRIC_KEY[metric]) })}
                  checked={draft[metric].enabled}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      [metric]: { ...current[metric], enabled: event.target.checked },
                    }))
                  }
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <label htmlFor={`threshold-${metric}`} className="t-sm font-semibold text-text">
                    {t(METRIC_KEY[metric])}
                  </label>
                  <span className="t-cap text-text-3">{t(METRIC_HINT_KEY[metric])}</span>
                </span>
                <span className="affix w-24">
                  <Input
                    id={`threshold-${metric}`}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={1000}
                    step={1}
                    className="input-sm mono pr-[26px] tabular-nums"
                    disabled={!draft[metric].enabled}
                    value={draft[metric].limitPercent}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        [metric]: { ...current[metric], limitPercent: event.target.value },
                      }))
                    }
                  />
                  <span aria-hidden className="t-cap absolute right-2.5 text-text-3">
                    %
                  </span>
                </span>
                <span className="flex w-[150px] flex-col items-start">
                  <span className="t-cap text-text-3">
                    {t(ORIGIN_KEY[thresholds[metric].origin])}
                  </span>
                  {thresholds[metric].origin === 'target' ? (
                    <button
                      type="button"
                      className="btn btn-link t-cap"
                      disabled={busy}
                      onClick={() => void reset(metric)}
                    >
                      {t('thresholds.reset')}
                    </button>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            {shared('cancel')}
          </Button>
          <Button onClick={() => void save()} loading={busy}>
            {busy ? shared('saving') : shared('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
