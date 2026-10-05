import type { Metadata } from 'next';
import { auth as messages } from '@/i18n/messages/auth';
import { getT } from '@/i18n/server';
import { ChoosePasswordForm } from '../choose-password-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT(messages))('meta.invitation') };
}

export const dynamic = 'force-dynamic';

/**
 * Landing of an invitation link.
 *
 * Technically identical to `/reset-password` — same token, same consumption
 * route, same component. What differs is the situation: the person never had a
 * password here, and talking to them about a "reset" would be wrong. It is
 * `sendResetPassword()` that chooses which of the two pages the link targets, from
 * the account's state and not from a URL parameter.
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
