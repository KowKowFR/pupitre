import type { Metadata } from 'next';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Connexion — Control plane' };
export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  // Ne redirige que vers un chemin interne : pas de redirection ouverte.
  const target = next?.startsWith('/') && !next.startsWith('//') ? next : '/';
  return <LoginForm next={target} />;
}
