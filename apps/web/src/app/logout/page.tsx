import type { Metadata } from 'next';
import { auth as messages } from '@/i18n/messages/auth';
import { getT } from '@/i18n/server';
import { LogoutRunner } from './logout-runner';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT(messages))('meta.logout') };
}

export default function LogoutPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <LogoutRunner />
    </div>
  );
}
