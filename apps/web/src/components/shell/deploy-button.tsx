'use client';

import { Rocket } from 'lucide-react';
import { Kbd } from '@/components/ui/kbd';
import { useHotkey, useShell } from './shell-provider';

/**
 * "Deploy": the overview's primary action. It opens the palette in "Deploy ›"
 * mode, which lists the applications; the D key does the same from the screen.
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
