'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatDigestDuration, type PresentedNotificationEvent } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

/**
 * Le garde-fou de volume, vu de l'écran.
 *
 * Deux choses seulement, et la seconde compte autant que la première :
 *
 *   — la **fenêtre de base**, réglable entre des bornes que le serveur impose.
 *     Le plancher n'est pas zéro : un garde-fou de volume désactivable est un
 *     garde-fou désactivé au premier agacement ;
 *   — l'**état à cet instant**. Sans lui, un opérateur qui ne reçoit rien ne
 *     peut pas distinguer « rien ne s'est passé » de « quarante alertes sont
 *     retenues, le résumé part dans deux minutes ». Et la réaction devant une
 *     couche de notification qu'on croit en panne est de la reconfigurer,
 *     c'est-à-dire de faire du bruit pour rien.
 *
 * L'état n'est pas rafraîchi tout seul : une fenêtre dure des minutes, un
 * sondage permanent ne montrerait rien de plus et tiendrait une requête ouverte
 * sur un écran qu'on laisse ouvert.
 */

export type DigestState = {
  groupKey: string;
  event: string;
  windowEndsAt: string | null;
  windowMs: number;
  escalation: number;
  heldCount: number;
  firstHeldAt: string | null;
  lastHeldAt: string | null;
};

export type DigestVocabulary = {
  minWindowMs: number;
  maxWindowMs: number;
  maxEscalation: number;
  widestWindowMs: number;
  itemLimit: number;
};

type ApiError = { error?: { message?: string } };

/**
 * Durées proposées. Une liste de paliers plutôt qu'un champ libre : personne
 * n'a besoin d'une fenêtre de 137 secondes, et un champ libre invite à saisir
 * la plus petite valeur acceptée « pour voir ».
 */
const PRESETS_MS = [15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000];

export function DigestPolicy({
  initialWindowMs,
  initialStates,
  vocabulary,
  events,
  canManage,
}: {
  initialWindowMs: number;
  initialStates: DigestState[];
  vocabulary: DigestVocabulary;
  events: PresentedNotificationEvent[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [windowMs, setWindowMs] = useState(initialWindowMs);
  const [states, setStates] = useState(initialStates);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // La valeur en base peut ne pas être un palier (réglée par script, ou palier
  // retiré) : on l'ajoute plutôt que de la faire disparaître du menu.
  const options = Array.from(new Set([...PRESETS_MS, initialWindowMs, windowMs]))
    .filter((value) => value >= vocabulary.minWindowMs && value <= vocabulary.maxWindowMs)
    .sort((a, b) => a - b);

  const labelOf = (key: string) => events.find((entry) => entry.key === key)?.label ?? key;

  async function save() {
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch('/api/notifications/digests', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ windowMs }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as ApiError;
        throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
      }
      setSaved(true);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  }

  async function refresh() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/notifications/digests');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as { states: DigestState[] };
      setStates(payload.states);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Alert variant="info">
        <p>
          La <strong>première</strong> alerte d’un incident part sans délai — c’est la règle qui
          prime sur toutes les autres. Elle ouvre une fenêtre de{' '}
          <strong>{formatDigestDuration(windowMs)}</strong> pendant laquelle les alertes suivantes du
          même type sont retenues au lieu d’être envoyées une par une.
        </p>
        <p className="mt-1.5">
          À la fermeture : rien de retenu, la fenêtre se referme et la prochaine panne isolée repart
          immédiatement. Quelque chose de retenu, un <strong>résumé</strong> part — il nomme chacune
          des alertes qu’il remplace, jusqu’à {vocabulary.itemLimit} — et la fenêtre s’ouvre à
          nouveau, deux fois plus longue, jusqu’à {formatDigestDuration(vocabulary.widestWindowMs)}.
          Un orage qui dure fait donc baisser la cadence tout seul.
        </p>
      </Alert>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="digest-window">Fenêtre de regroupement</Label>
          <Select
            id="digest-window"
            className="w-44"
            value={String(windowMs)}
            disabled={!canManage || pending}
            onChange={(event) => {
              setWindowMs(Number(event.target.value));
              setSaved(false);
            }}
          >
            {options.map((value) => (
              <option key={value} value={value}>
                {formatDigestDuration(value)}
              </option>
            ))}
          </Select>
        </div>

        {canManage ? (
          <Button size="sm" type="button" disabled={pending || windowMs === initialWindowMs} onClick={() => void save()}>
            Enregistrer
          </Button>
        ) : null}

        <Button size="sm" variant="ghost" type="button" disabled={pending} onClick={() => void refresh()}>
          Actualiser l’état
        </Button>
      </div>

      <p className="text-xs text-ink-faint">
        Réglable de {formatDigestDuration(vocabulary.minWindowMs)} à{' '}
        {formatDigestDuration(vocabulary.maxWindowMs)}. Le plancher n’est pas zéro : un garde-fou de
        volume qu’on peut désactiver est un garde-fou désactivé, et cinquante pannes redeviendraient
        cinquante messages.
      </p>

      {error ? <Alert variant="destructive">{error}</Alert> : null}
      {saved ? <Alert variant="success">Fenêtre enregistrée.</Alert> : null}

      <div className="space-y-2">
        <p className="eyebrow text-ink-muted">Regroupements en cours</p>
        {states.length === 0 ? (
          <p className="text-sm text-ink-faint">
            Aucune fenêtre ouverte : la prochaine alerte, quelle qu’elle soit, partira sans délai.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {states.map((state) => (
              <li
                key={state.groupKey}
                className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface-2/40 px-3 py-2 text-sm"
              >
                <span className="text-ink">{labelOf(state.event)}</span>
                <Badge variant={state.heldCount > 0 ? 'warn' : 'secondary'}>
                  {state.heldCount} retenue{state.heldCount > 1 ? 's' : ''}
                </Badge>
                <span className="text-xs text-ink-faint">
                  fenêtre de {formatDigestDuration(state.windowMs)}
                  {state.escalation > 0 ? ` (élargie ${state.escalation}×)` : ''}
                  {state.windowEndsAt
                    ? ` · se ferme à ${new Date(state.windowEndsAt).toLocaleTimeString('fr-FR')}`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
