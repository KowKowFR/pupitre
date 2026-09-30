'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { AppSettingsPatch } from '@pupitre/core';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { settings } from '@/i18n/messages/settings';
import { toast } from '@/lib/toast';

/**
 * Plomberie d'enregistrement commune aux sous-sections.
 *
 * Une seule route, `PATCH /api/settings`, et un corps qui **ne nomme que les
 * champs de la section en cours**. C'est tout l'intérêt du découpage : la
 * fusion côté serveur est partielle sur un niveau, une section n'écrase donc
 * jamais les réglages d'une autre. Renvoyer l'objet complet « pour être sûr »
 * réintroduirait exactement le couplage qu'on vient de défaire — et ferait
 * d'un enregistrement d'identité un moyen de réinitialiser la politique de
 * scan.
 *
 * `aiApiKey` ne fait pas partie d'`AppSettingsPatch` : le schéma de la route
 * l'ajoute, et ses trois cas doivent survivre jusqu'ici — propriété absente =
 * clé inchangée, `null` = effacée, chaîne = remplacée.
 */
export type SettingsPatchBody = AppSettingsPatch & { aiApiKey?: string | null };

type ApiError = { error?: { message?: string } };

export type SettingsPatch = {
  save: (body: SettingsPatchBody) => Promise<boolean>;
  pending: boolean;
  error: string | null;
  /** Efface le bandeau d'erreur — appelé quand la section revient à ses valeurs enregistrées. */
  clearFeedback: () => void;
};

export function useSettingsPatch(): SettingsPatch {
  const router = useRouter();
  const t = useT(common);
  const ts = useT(settings);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function save(body: SettingsPatchBody): Promise<boolean> {
    setPending(true);
    setError(null);

    const response = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as ApiError;
      setError(payload.error?.message ?? t('http.failure', { status: response.status }));
      setPending(false);
      return false;
    }

    toast({ title: ts('form.saved') });
    setPending(false);
    // Les paramètres irriguent le rail, le titre du document et toutes les
    // dates : c'est la page entière qu'il faut réémettre, pas ce formulaire.
    router.refresh();
    return true;
  }

  function clearFeedback() {
    setError(null);
  }

  return { save, pending, error, clearFeedback };
}
