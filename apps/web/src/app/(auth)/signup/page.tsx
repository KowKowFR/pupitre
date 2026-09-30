import type { Metadata } from 'next';
import Link from 'next/link';
import { auth as messages } from '@/i18n/messages/auth';
import { getT } from '@/i18n/server';
import { isSignupOpen } from '@/lib/auth';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { AuthCard } from '../auth-card';
import { SignupForm } from './signup-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT(messages))('meta.signup') };
}

export const dynamic = 'force-dynamic';

export default async function SignupPage() {
  if (!(await isSignupOpen())) {
    const t = await getT(messages);

    return (
      <AuthCard title={t('signup.closed.title')} description={t('signup.closed.description')}>
        <Alert variant="info">
          {t('signup.closed.hint')} <code className="mono">ALLOW_SIGNUP=true</code>.
        </Alert>
        <Button asChild variant="secondary" className="btn-block">
          <Link href="/login">{t('link.backToLogin')}</Link>
        </Button>
      </AuthCard>
    );
  }

  return <SignupForm />;
}
