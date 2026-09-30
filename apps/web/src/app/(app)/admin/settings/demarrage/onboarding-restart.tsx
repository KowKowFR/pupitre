'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Compass } from 'lucide-react';
import type { OnboardingState } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { onboarding } from '@/i18n/messages/onboarding';
import { settings as messages } from '@/i18n/messages/settings';

/**
 * Relance de l'assistant de démarrage depuis les paramètres.
 *
 * L'assistant doit rester atteignable même quand il a été terminé ou abandonné :
 * quelqu'un qui a tout passé la première fois — parce qu'aucune machine
 * n'était prête — doit pouvoir y revenir sans qu'on lui demande de retoucher la
 * base. Le bouton remet le parcours à zéro (`PATCH /api/onboarding`,
 * `restart`), ce qui exige `settings:manage` : cet état est celui de
 * l'instance, pas celui de la personne connectée.
 */

/**
 * Les clés d'état, dans le dictionnaire des paramètres : le sommaire affiche
 * exactement les mêmes quatre mots, et deux tables séparées finiraient par
 * diverger.
 */
const STATUS_KEY = {
  pending: 'onboarding.status.pending',
  in_progress: 'onboarding.status.inProgress',
  dismissed: 'onboarding.status.dismissed',
  completed: 'onboarding.status.completed',
} as const satisfies Record<OnboardingState['status'], string>;

const STATUS_VARIANT = {
  pending: 'secondary',
  in_progress: 'default',
  dismissed: 'warn',
  completed: 'ok',
} as const;

type ApiError = { error?: { message?: string } };

export function OnboardingRestart({
  state,
  canManage,
}: {
  state: OnboardingState;
  canManage: boolean;
}) {
  const router = useRouter();
  const t = useT(messages);
  const tc = useT(common);
  const to = useT(onboarding);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function restart() {
    setPending(true);
    setError(null);

    const response = await fetch('/api/onboarding', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'restart' }),
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as ApiError;
      setError(payload.error?.message ?? tc('http.failure', { status: response.status }));
      setPending(false);
      return;
    }

    setPending(false);
    router.push('/onboarding');
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t('section.onboarding.title')}
          <Badge variant={STATUS_VARIANT[state.status]}>{t(STATUS_KEY[state.status])}</Badge>
        </CardTitle>
        <CardDescription>{t('onboarding.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-[0.8125rem] sm:grid-cols-2">
          <div className="flex justify-between gap-3 border-b border-border pb-1.5">
            <dt className="text-text-2">{t('onboarding.term.completed')}</dt>
            <dd className="mono text-text tabular-nums">{state.completed.length}</dd>
          </div>
          <div className="flex justify-between gap-3 border-b border-border pb-1.5">
            <dt className="text-text-2">{t('onboarding.term.skipped')}</dt>
            <dd className="mono text-text tabular-nums">{state.skipped.length}</dd>
          </div>
          <div className="flex justify-between gap-3 border-b border-border pb-1.5">
            <dt className="text-text-2">{t('onboarding.term.currentStep')}</dt>
            {/*
              `state.currentStep` est une clé interne (`summary`, `identity`…).
              L'afficher telle quelle laissait un identifiant en chasse fixe au
              milieu d'un écran entièrement rédigé — et sans indiquer à quoi il
              correspond. Le titre de l'étape dit la même chose, dans la langue
              de l'instance : il se lit dans le dictionnaire de l'assistant, où
              vit désormais toute sa prose.
            */}
            <dd className="text-text">{to(`step.${state.currentStep}.title`)}</dd>
          </div>
          <div className="flex justify-between gap-3 border-b border-border pb-1.5">
            <dt className="text-text-2">{t('onboarding.term.runs')}</dt>
            <dd className="mono text-text tabular-nums">{state.runs}</dd>
          </div>
        </dl>

        <p className="help">{t('onboarding.reset.help')}</p>

        <div className="flex flex-wrap items-center gap-2">
          {canManage ? (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => void restart()}>
              <Compass />
              {pending ? t('onboarding.restarting') : t('onboarding.restart')}
            </Button>
          ) : (
            <span className="help">
              {t('onboarding.needPermission.before')} <code className="mono">settings:manage</code>{' '}
              {t('onboarding.needPermission.after')}
            </span>
          )}
          {state.status === 'in_progress' ? (
            <Button asChild size="sm" variant="ghost">
              <Link href="/onboarding">{t('onboarding.resume')}</Link>
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
