'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { HostMetrics } from '@pupitre/core';

/**
 * Relevé des métriques d'hôte, côté navigateur.
 *
 * ### Quand le relevé part
 *
 * **Au chargement de l'écran, pas à l'ouverture du dépliant.** Un écran de
 * supervision qui n'affiche rien tant qu'on n'a pas cliqué ne supervise pas :
 * la charge et le disque doivent être lisibles d'un coup d'œil, sans ouvrir
 * quoi que ce soit. Le dépliant, lui, ne contient que la liste des
 * applications — elle vient de la base, elle est déjà rendue, l'ouvrir ne coûte
 * donc aucune requête.
 *
 * ### Pourquoi dix machines ne font pas dix sessions SSH
 *
 * Les relevés sont mis en file côté client et exécutés **deux à la fois**. Dix
 * cibles font cinq vagues d'environ une seconde, pas dix sessions simultanées
 * — et le worker garde ses slots de supervision pour les flux de logs.
 *
 * ### Pourquoi aucun rafraîchissement automatique
 *
 * Un intervalle transformerait un onglet oublié en sonde permanente : chaque
 * relevé ouvre une vraie session SSH sur une vraie machine. Le relevé affiche
 * donc son âge (« il y a 2 min »), qui vieillit sous les yeux du lecteur, et
 * se redemande d'un bouton — par serveur ou pour toute la liste. C'est le
 * lecteur qui décide de payer, jamais la page.
 */

export type MetricsEntry =
  | { state: 'loading' }
  | { state: 'ready'; metrics: HostMetrics; at: number }
  | { state: 'error'; message: string; at: number };

type ApiError = { error?: { message?: string } };

/** Relevés simultanés. Deux : assez pour que la liste se remplisse vite, assez peu
 *  pour qu'un écran ouvert ne devienne pas une rafale de connexions SSH. */
const CONCURRENCY = 2;

/**
 * Interrogation nue. Hors du composant, donc stable : elle ne touche à aucun
 * état et peut être appelée depuis un effet sans provoquer de rendu.
 */
async function probeOnce(targetId: string): Promise<MetricsEntry> {
  try {
    const response = await fetch(`/api/targets/${targetId}/metrics`, { cache: 'no-store' });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      return {
        state: 'error',
        message: body.error?.message ?? `Relevé impossible (HTTP ${response.status})`,
        at: Date.now(),
      };
    }
    return { state: 'ready', metrics: (await response.json()) as HostMetrics, at: Date.now() };
  } catch {
    return { state: 'error', message: 'Le panel est injoignable', at: Date.now() };
  }
}

export function useHostMetrics(targetIds: string[], enabled: boolean) {
  const [entries, setEntries] = useState<Record<string, MetricsEntry>>({});
  // Cibles déjà relevées au moins une fois : le premier relevé ne se rejoue pas
  // à chaque `router.refresh()` déclenché par une action sur la page.
  const requested = useRef(new Set<string>());

  // `targetIds` est un tableau neuf à chaque rendu : on dépend de son contenu.
  const idsKey = targetIds.join(',');

  useEffect(() => {
    if (!enabled) return;

    const pending = idsKey.split(',').filter((id) => id !== '' && !requested.current.has(id));
    if (pending.length === 0) return;
    for (const id of pending) requested.current.add(id);

    let cancelled = false;
    const queue = [...pending];

    // Aucun `setState` avant le premier `await` : le premier rendu affiche
    // « relevé en cours » par absence d'entrée, pas par un état posé ici.
    void Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        for (;;) {
          const id = queue.shift();
          if (id === undefined) return;
          const entry = await probeOnce(id);
          if (cancelled) return;
          setEntries((current) => ({ ...current, [id]: entry }));
        }
      }),
    );

    return () => {
      cancelled = true;
    };
  }, [idsKey, enabled]);

  /** Redemande un relevé. Appelé depuis un gestionnaire d'événement, jamais d'un effet. */
  const refresh = useCallback(async (targetId: string) => {
    requested.current.add(targetId);
    setEntries((current) => ({ ...current, [targetId]: { state: 'loading' } }));
    const entry = await probeOnce(targetId);
    setEntries((current) => ({ ...current, [targetId]: entry }));
  }, []);

  const refreshAll = useCallback(async () => {
    const ids = idsKey.split(',').filter((id) => id !== '');
    if (ids.length === 0) return;

    for (const id of ids) requested.current.add(id);
    setEntries(Object.fromEntries(ids.map((id) => [id, { state: 'loading' as const }])));

    const queue = [...ids];
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        for (;;) {
          const id = queue.shift();
          if (id === undefined) return;
          const entry = await probeOnce(id);
          setEntries((current) => ({ ...current, [id]: entry }));
        }
      }),
    );
  }, [idsKey]);

  return { entries, refresh, refreshAll };
}
