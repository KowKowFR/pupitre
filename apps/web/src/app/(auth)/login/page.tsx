import type { Metadata } from 'next';
import { auth as messages } from '@/i18n/messages/auth';
import { getT } from '@/i18n/server';
import { canSendAccountMail } from '@/lib/account-mail';
import { isSignupOpen } from '@/lib/auth';
import { currentSso, ssoButton } from '@/lib/sso';
import { LoginForm } from './login-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT(messages))('meta.login') };
}

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  // Un fournisseur éteint au démarrage du panel est retenté ici, au plus une
  // fois par minute : le bouton revient de lui-même.
  await currentSso();
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
      sso={ssoButton()}
      ssoError={typeof error === 'string' ? error.slice(0, 80) : null}
    />
  );
}
