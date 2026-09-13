'use client';

/**
 * ⚠ Bouchon — ce fichier appartient au chantier « gestes sur une application en
 * marche » (arrêter, redémarrer, revenir en arrière, redéployer, détruire) et
 * sera **remplacé en entier** par sa version. Il n'est ici que pour que l'écran
 * de supervision ait quelque chose à importer et pour que le seul geste qui
 * existe aujourd'hui — le redémarrage — ne disparaisse pas de l'écran pendant
 * la refonte. Ne rien y ajouter : la fusion gardera l'autre version.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

type ApiError = { error?: { message?: string } };

export function AppActions({
  deploymentId,
  applicationSlug,
  canDeploy,
}: {
  deploymentId: string;
  applicationId: string;
  applicationSlug: string;
  targetName: string;
  runtime: 'docker' | 'k3s';
  canDeploy: boolean;
  canDestroy: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canDeploy) return null;

  async function restart() {
    if (
      !window.confirm(
        `Redémarrer « ${applicationSlug} » ?\n\n` +
          "Mêmes images, mêmes volumes, même port. L'application sera brièvement indisponible.",
      )
    ) {
      return;
    }

    setBusy(true);
    setError(null);

    const response = await fetch(`/api/apps/${deploymentId}/restart`, { method: 'POST' });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? `Échec (HTTP ${response.status})`);
      setBusy(false);
      return;
    }

    // La progression du redémarrage arrive par le flux de l'application : la
    // console la montre, il n'y a rien à attendre ici.
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void restart()}>
        {busy ? 'Redémarrage…' : 'Redémarrer'}
      </Button>
    </div>
  );
}
