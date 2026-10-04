import type { Metadata } from 'next';
import { auth as messages } from '@/i18n/messages/auth';
import { getT } from '@/i18n/server';
import { ChoosePasswordForm } from '../choose-password-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT(messages))('meta.reset') };
}

export const dynamic = 'force-dynamic';

/**
 * Landing of a reset link.
 *
 * The email's link targets `/api/auth/reset-password/{token}`: a Better Auth GET
 * that **checks the token without consuming it**, then redirects here with
 * `?token=` if it is good, or `?error=INVALID_TOKEN` if it is dead. We keep this
 * detour: without it, an expired link would let someone compose a password
 * before telling them it was for nothing.
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
