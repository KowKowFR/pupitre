import type { Metadata } from 'next';
import { auth as messages } from '@/i18n/messages/auth';
import { getT } from '@/i18n/server';
import { ChoosePasswordForm } from '../choose-password-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT(messages))('meta.reset') };
}

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
  const t = await getT(messages);

  return (
    <ChoosePasswordForm
      token={token ?? null}
      linkError={error ?? null}
      copy={{
        title: t('reset.title'),
        description: t('reset.description'),
        submit: t('reset.submit'),
        doneTitle: t('reset.done.title'),
        doneBody: t('reset.done.body'),
        deadTitle: t('reset.dead.title'),
        deadBody: t('reset.dead.body'),
      }}
    />
  );
}
