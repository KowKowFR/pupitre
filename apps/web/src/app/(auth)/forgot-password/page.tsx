import type { Metadata } from 'next';
import Link from 'next/link';
import { auth as messages } from '@/i18n/messages/auth';
import { getT } from '@/i18n/server';
import { canSendAccountMail } from '@/lib/account-mail';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { AuthCard } from '../auth-card';
import { ForgotPasswordForm } from './forgot-password-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT(messages))('meta.forgot') };
}

export const dynamic = 'force-dynamic';

/**
 * Without an email channel, the form is not shown.
 *
 * It is the point this work was determined not to miss: a screen that accepts an
 * address, says thank you, and sends nothing, is worse than no screen at all —
 * the person waits for a message that cannot exist, and concludes that the panel
 * is broken. Here they read what really happens, and whom to turn to.
 *
 * The link to this page is hidden on the sign-in screen in the same case: both
 * read the same function, so there are not two truths.
 */
export default async function ForgotPasswordPage() {
  if (!(await canSendAccountMail())) {
    const t = await getT(messages);

    return (
      <AuthCard
        title={t('forgot.unavailable.title')}
        description={t('forgot.unavailable.description')}
      >
        <Alert variant="warn">
          {t('forgot.unavailable.hint.before')} <strong>{t('forgot.unavailable.hint.path')}</strong>{' '}
          {t('forgot.unavailable.hint.after')}
        </Alert>
        <Button asChild variant="secondary" className="btn-block">
          <Link href="/login">{t('link.backToLogin')}</Link>
        </Button>
      </AuthCard>
    );
  }

  return <ForgotPasswordForm />;
}
