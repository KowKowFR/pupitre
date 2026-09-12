import type { Metadata } from 'next';
import { ChoosePasswordForm } from '../choose-password-form';

export const metadata: Metadata = { title: 'Nouveau mot de passe — Pupitre' };
export const dynamic = 'force-dynamic';

/**
 * Atterrissage d'un lien de réinitialisation.
 *
 * Le lien de l'e-mail vise `/api/auth/reset-password/{jeton}` : un GET de Better
 * Auth qui **vérifie le jeton sans le consommer**, puis redirige ici avec
 * `?token=` s'il est bon, ou `?error=INVALID_TOKEN` s'il est mort. On garde ce
 * détour : sans lui, un lien périmé laisserait quelqu'un composer un mot de
 * passe avant de lui dire que c'était pour rien.
 */
export default async function ResetPasswordPage({
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
        title: 'Nouveau mot de passe',
        description:
          'Choisissez un mot de passe. Toutes les sessions ouvertes sur ce compte seront fermées, y compris celles que vous n’avez pas ouvertes.',
        submit: 'Enregistrer et fermer les sessions',
        doneTitle: 'Mot de passe changé',
        doneBody:
          'Les sessions ouvertes sur ce compte ont été fermées. Reconnectez-vous avec votre nouveau mot de passe.',
        deadTitle: 'Lien de réinitialisation périmé',
        deadBody: 'Ce lien ne permet plus de changer de mot de passe.',
      }}
    />
  );
}
