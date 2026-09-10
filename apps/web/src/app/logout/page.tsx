import type { Metadata } from 'next';
import { LogoutRunner } from './logout-runner';

export const metadata: Metadata = { title: 'Déconnexion — Control plane' };

export default function LogoutPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <LogoutRunner />
    </div>
  );
}
