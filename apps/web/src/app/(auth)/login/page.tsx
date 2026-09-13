import type { Metadata } from 'next';
import { canSendAccountMail } from '@/lib/account-mail';
import { isSignupOpen } from '@/lib/auth';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Connexion — Pupitre' };
export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  // Ne redirige que vers un chemin interne : pas de redirection ouverte.
  const target = next?.startsWith('/') && !next.startsWith('//') ? next : '/';

  /**
   * Le lien « Mot de passe oublié » n'apparaît que si l'instance sait poster un
   * e-mail. Proposer un parcours qui finira en silence est pire que ne rien
   * proposer : la personne s'y engage, attend un message qui ne peut pas
   * exister, et conclut que le panel est en panne au lieu d'aller chercher un
   * administrateur.
   */
  // Même règle pour l'inscription : un lien qui mène à « Inscription fermée »
  // n'apprend rien qu'on ne puisse dire ici, en une phrase.
  return (
    <LoginForm
      next={target}
      canRecoverPassword={await canSendAccountMail()}
      signupOpen={await isSignupOpen()}
    />
  );
}
