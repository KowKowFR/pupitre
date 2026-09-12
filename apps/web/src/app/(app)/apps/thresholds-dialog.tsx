'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SlidersHorizontal } from 'lucide-react';
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
import { Label } from '@/components/ui/label';
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

const METRIC_LABEL: Record<HistoryMetric, string> = {
  disk: 'Disque',
  memory: 'Mémoire',
  load: 'Charge par cœur',
};

const METRIC_HINT: Record<HistoryMetric, string> = {
  disk: 'partition qui porte les déploiements',
  memory: 'utilisée = totale − disponible',
  load: '100 % = un cœur plein par cœur',
};

const ORIGIN_LABEL: Record<ThresholdView['origin'], string> = {
  default: 'valeur livrée avec le panel',
  global: "défaut de l'instance",
  target: 'propre à cette machine',
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
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<HistoryMetric, Draft>>(() =>
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
          setError(`« ${METRIC_LABEL[metric]} » : un pourcentage entre 1 et 1000 est attendu.`);
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
          setError(body.error?.message ?? `Enregistrement refusé (HTTP ${response.status})`);
          return;
        }
      }
      setOpen(false);
      // Les seuils décident de la couleur des jauges et du trait de la frise :
      // la page doit se relire pour que l'écran dise la vérité tout de suite.
      router.refresh();
    } catch {
      setError('Le panel est injoignable.');
    } finally {
      setBusy(false);
    }
  }, [draft, router, targetId]);

  /** Retire la surcharge de cette machine : la couche du dessous reprend. */
  const reset = useCallback(
    async (metric: HistoryMetric) => {
      setBusy(true);
      setError(null);
      try {
        await fetch(
          `/api/supervision/thresholds?targetId=${targetId}&metric=${metric}`,
          { method: 'DELETE' },
        );
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
        <Button size="sm" variant="ghost" aria-label={`Régler les seuils de ${targetName}`}>
          <SlidersHorizontal />
          Seuils
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Seuils de {targetName}</DialogTitle>
          <DialogDescription>
            Au-delà du seuil, un dépassement s&apos;ouvre et une entrée est écrite au journal
            d&apos;activité — <strong>une seule</strong>, au franchissement, pas une par relevé.
            Elle se referme quand la machine repasse sous le seuil.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          {error ? <Alert variant="destructive">{error}</Alert> : null}

          {METRICS.map((metric) => (
            <div key={metric} className="flex flex-col gap-1.5">
              <div className="flex items-end gap-3">
                <div className="flex-1">
                  <Label htmlFor={`threshold-${metric}`}>{METRIC_LABEL[metric]}</Label>
                  <p className="text-[0.6875rem] text-ink-faint">{METRIC_HINT[metric]}</p>
                </div>
                <Input
                  id={`threshold-${metric}`}
                  type="number"
                  min={1}
                  max={1000}
                  step={1}
                  className="w-24 font-mono tabular-nums"
                  value={draft[metric].limitPercent}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      [metric]: { ...current[metric], limitPercent: event.target.value },
                    }))
                  }
                />
                <span className="pb-2 text-[0.75rem] text-ink-faint">%</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-[0.75rem] text-ink-muted">
                  <Checkbox
                    checked={draft[metric].enabled}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        [metric]: { ...current[metric], enabled: event.target.checked },
                      }))
                    }
                  />
                  Surveiller cette métrique
                </label>
                <span className="text-[0.6875rem] text-ink-faint">
                  {ORIGIN_LABEL[thresholds[metric].origin]}
                  {thresholds[metric].origin === 'target' ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void reset(metric)}
                      className="ml-2 underline underline-offset-2 hover:text-ink"
                    >
                      rendre au défaut
                    </button>
                  ) : null}
                </span>
              </div>
            </div>
          ))}
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Annuler
          </Button>
          <Button onClick={() => void save()} disabled={busy}>
            {busy ? 'Enregistrement…' : 'Enregistrer'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
