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
  // Arrived here because a session was closed elsewhere: the requested page is
  // passed on to `/login`, which validates it before using it.
  const { next } = await searchParams;
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <LogoutRunner next={next ?? null} />
    </div>
  );
}
