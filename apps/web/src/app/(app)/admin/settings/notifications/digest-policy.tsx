'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatDigestDuration, type PresentedNotificationEvent } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { notifications as messages } from '@/i18n/messages/notifications';
import { formatDateTimeWith, type FormatSettings } from '@/lib/format';

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
const PRESETS_MS = [
  15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000,
];

export function DigestPolicy({
  initialWindowMs,
  initialStates,
  vocabulary,
  events,
  canManage,
  format,
}: {
  initialWindowMs: number;
  initialStates: DigestState[];
  vocabulary: DigestVocabulary;
  events: PresentedNotificationEvent[];
  canManage: boolean;
  /** Locale et fuseau de l'instance. Par props : cet écran est rendu sur le
   *  serveur avant de l'être ici, et les deux doivent écrire la même heure. */
  format: FormatSettings;
}) {
  const router = useRouter();
  const t = useT(messages);
  const tc = useT(common);
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
          {t('digest.rule.lead')} <strong>{t('digest.rule.first')}</strong> {t('digest.rule.opens')}{' '}
          <strong>{formatDigestDuration(windowMs)}</strong> {t('digest.rule.holds')}
        </p>
        <p className="mt-1.5">
          {t('digest.close.lead')} <strong>{t('digest.close.digest')}</strong>{' '}
          {t('digest.close.rest', {
            limit: vocabulary.itemLimit,
            widest: formatDigestDuration(vocabulary.widestWindowMs),
          })}
        </p>
      </Alert>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="digest-window">{t('digest.window.label')}</Label>
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
          <Button
            size="sm"
            type="button"
            disabled={pending || windowMs === initialWindowMs}
            onClick={() => void save()}
          >
            {tc('save')}
          </Button>
        ) : null}

        <Button
          size="sm"
          variant="ghost"
          type="button"
          disabled={pending}
          onClick={() => void refresh()}
        >
          {t('digest.refresh')}
        </Button>
      </div>

      <p className="text-xs text-text-3">
        {t('digest.window.help', {
          min: formatDigestDuration(vocabulary.minWindowMs),
          max: formatDigestDuration(vocabulary.maxWindowMs),
        })}
      </p>

      {error ? <Alert variant="destructive">{error}</Alert> : null}
      {saved ? <Alert variant="success">{t('digest.saved')}</Alert> : null}

      <div className="space-y-2">
        <p className="eyebrow text-text-2">{t('digest.open.title')}</p>
        {states.length === 0 ? (
          <p className="text-sm text-text-3">{t('digest.open.none')}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {states.map((state) => (
              <li
                key={state.groupKey}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-2/40 px-3 py-2 text-sm"
              >
                <span className="text-text">{labelOf(state.event)}</span>
                <Badge variant={state.heldCount > 0 ? 'warn' : 'secondary'}>
                  {t('digest.held', { count: state.heldCount })}
                </Badge>
                <span className="text-xs text-text-3">
                  {t('digest.state.window', { window: formatDigestDuration(state.windowMs) })}
                  {state.escalation > 0
                    ? ` ${t('digest.state.widened', { times: state.escalation })}`
                    : ''}
                  {state.windowEndsAt
                    ? ` ${t('digest.state.closesAt', {
                        // `settings.locale` tel quel : `toLocaleTimeString('en')`
                        // rendait « 2:32 PM » sur une instance `en-GB`.
                        time: formatDateTimeWith(state.windowEndsAt, format, {
                          timeStyle: 'medium',
                        }),
                      })}`
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
