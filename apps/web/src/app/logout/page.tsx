import type { Metadata } from 'next';
import { auth as messages } from '@/i18n/messages/auth';
import { getT } from '@/i18n/server';
import { LogoutRunner } from './logout-runner';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT(messages))('meta.logout') };
}

export default async function LogoutPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  // Arrivé ici parce qu'une session a été fermée ailleurs : la page demandée
  // est transmise à `/login`, qui la valide avant de s'en servir.
  const { next } = await searchParams;
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <LogoutRunner next={next ?? null} />
    </div>
  );
}
