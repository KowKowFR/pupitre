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
  // A provider that was off when the panel started is retried here, at most once a
  // minute: the button comes back by itself.
  await currentSso();
  // Only redirects to an internal path: no open redirect.
  const target = next?.startsWith('/') && !next.startsWith('//') ? next : '/';

  /**
   * The "Forgot password" link only appears if the instance can post an email.
   * Offering a journey that will end in silence is worse than offering nothing: the
   * person engages in it, waits for a message that cannot exist, and concludes that
   * the panel is broken instead of going to find an administrator.
   */
  // The same rule for sign-up: a link that leads to "Sign-up closed" teaches
  // nothing that cannot be said here, in one sentence.
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
