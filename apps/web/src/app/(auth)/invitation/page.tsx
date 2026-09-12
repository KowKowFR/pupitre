import type { Metadata } from 'next';
import { ChoosePasswordForm } from '../choose-password-form';

export const metadata: Metadata = { title: 'Invitation — Pupitre' };
export const dynamic = 'force-dynamic';

/**
 * Atterrissage d'un lien d'invitation.
 *
 * Techniquement identique à `/reset-password` — même jeton, même route de
 * consommation, même composant. Ce qui diffère est la situation : la personne
 * n'a jamais eu de mot de passe ici, et lui parler de « réinitialisation »
 * serait faux. C'est `sendResetPassword()` qui choisit laquelle des deux pages
 * le lien vise, à partir de l'état du compte et non d'un paramètre d'URL.
 */
export default async function InvitationPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { token, error } = await searchParams;

  return (
    <ChoosePasswordForm
      token={token ?? null}
      linkError={error ?? null}
      copy={{
        title: 'Choisissez votre mot de passe',
        description:
          'Votre compte est prêt. Il ne lui manque qu’un mot de passe — vous seul le connaîtrez.',
        submit: 'Activer mon compte',
        doneTitle: 'Compte activé',
        doneBody: 'Votre mot de passe est enregistré. Connectez-vous pour entrer dans le panel.',
        deadTitle: 'Invitation périmée',
        deadBody: 'Ce lien d’invitation a déjà servi, ou son délai est passé.',
      }}
    />
  );
}
