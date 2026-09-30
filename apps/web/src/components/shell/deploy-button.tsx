'use client';

import { Rocket } from 'lucide-react';
import { Kbd } from '@/components/ui/kbd';
import { useHotkey, useShell } from './shell-provider';

/**
 * « Déployer » : l'action primaire de la vue d'ensemble. Elle ouvre la palette
 * en mode « Déployer › », qui liste les applications ; la touche D fait de
 * même depuis l'écran.
 */
export function DeployButton({ label }: { label: string }) {
  const { openPalette } = useShell();
  useHotkey('D', () => openPalette('deploy'));
  return (
    <button type="button" className="btn btn-primary" onClick={() => openPalette('deploy')}>
      <Rocket aria-hidden />
      {label}
      <Kbd>D</Kbd>
    </button>
  );
}
