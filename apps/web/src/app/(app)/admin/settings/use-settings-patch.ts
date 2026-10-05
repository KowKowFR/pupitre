'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { AppSettingsPatch } from '@pupitre/core';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { settings } from '@/i18n/messages/settings';
import { toast } from '@/lib/toast';

/**
 * The saving plumbing shared by the subsections.
 *
 * A single route, `PATCH /api/settings`, and a body that **only names the
 * current section's fields**. That is the whole point of the split: the
 * server-side merge is partial on one level, so a section never overwrites
 * another's settings. Sending the whole object back "to be sure" would
 * reintroduce exactly the coupling that was just undone — and would make an
 * identity save a way to reset the scan policy.
 *
 * `aiApiKey` is not part of `AppSettingsPatch`: the route's schema adds it, and
 * its three cases must survive all the way here — absent property = key
 * unchanged, `null` = cleared, string = replaced.
 */
export type SettingsPatchBody = AppSettingsPatch & {
  aiApiKey?: string | null;
  ssoClientSecret?: string | null;
};

type ApiError = { error?: { message?: string } };

export type SettingsPatch = {
  save: (body: SettingsPatchBody) => Promise<boolean>;
  pending: boolean;
  error: string | null;
  /** Clears the error banner — called when the section goes back to its saved values. */
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
    // The settings feed the rail, the document's title and every date: it is the
    // whole page that must be emitted again, not this form.
    router.refresh();
    return true;
  }

  function clearFeedback() {
    setError(null);
  }

  return { save, pending, error, clearFeedback };
}
