'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Compass } from 'lucide-react';
import { onboardingStep, type OnboardingState } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

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

const STATUS_LABEL: Record<OnboardingState['status'], string> = {
  pending: 'jamais lancé',
  in_progress: 'en cours',
  dismissed: 'abandonné',
  completed: 'terminé',
};

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
      setError(payload.error?.message ?? `Échec (HTTP ${response.status})`);
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
          Assistant de démarrage
          <Badge variant={STATUS_VARIANT[state.status]}>{STATUS_LABEL[state.status]}</Badge>
        </CardTitle>
        <CardDescription>
          Le parcours de prise en main : nommer l&apos;instance, déclarer une première cible, créer
          un rôle et un compte. Il ne fait rien que ces écrans ne fassent — il les met dans
          l&apos;ordre.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <dl className="grid gap-x-6 gap-y-1.5 text-[0.8125rem] sm:grid-cols-2">
          <div className="flex justify-between gap-3 border-b border-line pb-1.5">
            <dt className="text-ink-muted">Étapes accomplies</dt>
            <dd className="font-mono text-ink tabular-nums">{state.completed.length}</dd>
          </div>
          <div className="flex justify-between gap-3 border-b border-line pb-1.5">
            <dt className="text-ink-muted">Étapes passées</dt>
            <dd className="font-mono text-ink tabular-nums">{state.skipped.length}</dd>
          </div>
          <div className="flex justify-between gap-3 border-b border-line pb-1.5">
            <dt className="text-ink-muted">Étape en cours</dt>
            {/*
              `state.currentStep` est une clé interne (`summary`, `identity`…).
              L'afficher telle quelle laissait un mot anglais en chasse fixe au
              milieu d'un écran entièrement rédigé — et sans indiquer à quoi il
              correspond. Le titre de l'étape dit la même chose, en français.
            */}
            <dd className="text-ink">{onboardingStep(state.currentStep).title}</dd>
          </div>
          <div className="flex justify-between gap-3 border-b border-line pb-1.5">
            <dt className="text-ink-muted">Relances</dt>
            <dd className="font-mono text-ink tabular-nums">{state.runs}</dd>
          </div>
        </dl>

        <p className="text-xs text-ink-faint">
          Relancer remet le parcours à zéro et vous y renvoie. Rien n&apos;est défait : les cibles,
          rôles et comptes déjà créés restent en place — seul le souvenir de l&apos;avancement est
          effacé.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          {canManage ? (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => void restart()}>
              <Compass />
              {pending ? 'Relance…' : "Relancer l'assistant"}
            </Button>
          ) : (
            <span className="text-xs text-ink-faint">
              La permission <code className="font-mono">settings:manage</code> est requise pour le
              relancer.
            </span>
          )}
          {state.status === 'in_progress' ? (
            <Button asChild size="sm" variant="ghost">
              <Link href="/onboarding">Reprendre où j&apos;en étais</Link>
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
