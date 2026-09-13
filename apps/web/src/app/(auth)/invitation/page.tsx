import type { Metadata } from 'next';
import { auth as messages } from '@/i18n/messages/auth';
import { getT } from '@/i18n/server';
import { ChoosePasswordForm } from '../choose-password-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT(messages))('meta.invitation') };
}

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
  const t = await getT(messages);

  return (
    <ChoosePasswordForm
      token={token ?? null}
      linkError={error ?? null}
      copy={{
        title: t('invitation.title'),
        description: t('invitation.description'),
        submit: t('invitation.submit'),
        doneTitle: t('invitation.done.title'),
        doneBody: t('invitation.done.body'),
        deadTitle: t('invitation.dead.title'),
        deadBody: t('invitation.dead.body'),
      }}
    />
  );
}
