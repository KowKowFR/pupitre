'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Compass } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Rappel de reprise, posé en tête de chaque page tant que l'assistant n'est ni
 * terminé ni abandonné.
 *
 * C'est la contrepartie de la redirection unique : on ne force le passage
 * qu'une fois, mais on ne laisse pas non plus l'assistant disparaître sans que
 * personne ne l'ait tranché. Deux issues, toutes deux visibles — reprendre, ou
 * dire explicitement qu'on s'en occupera plus tard.
 *
 * Le composant s'efface de lui-même sur `/onboarding` : un layout serveur ne
 * connaît pas le chemin courant, un composant client oui. C'est la seule raison
 * pour laquelle il est client.
 */
export function OnboardingBanner({
  stepTitle,
  done,
  total,
}: {
  stepTitle: string;
  done: number;
  total: number;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [pending, setPending] = useState(false);

  if (pathname.startsWith('/onboarding')) return null;

  async function dismiss() {
    setPending(true);
    await fetch('/api/onboarding', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'dismiss' }),
    });
    setPending(false);
    router.refresh();
  }

  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-signal-edge border-l-[3px] border-l-signal bg-signal-soft/50 px-3.5 py-2.5">
      <Compass className="size-4 shrink-0 text-signal" aria-hidden />
      <div className="min-w-0 flex-1">
        <span className="text-[0.8125rem] leading-relaxed text-ink">
          Prise en main en cours — prochaine étape&nbsp;: <strong>{stepTitle}</strong>.
        </span>{' '}
        <span className="font-mono text-xs text-ink-muted tabular-nums">
          {done}/{total} étape{total > 1 ? 's' : ''}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button asChild size="sm">
          <Link href="/onboarding">Reprendre</Link>
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => void dismiss()}>
          Plus tard
        </Button>
      </div>
    </div>
  );
}
