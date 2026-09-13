import type { Metadata } from 'next';
import Link from 'next/link';
import { auth as messages } from '@/i18n/messages/auth';
import { getT } from '@/i18n/server';
import { isSignupOpen } from '@/lib/auth';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SignupForm } from './signup-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT(messages))('meta.signup') };
}

export const dynamic = 'force-dynamic';

export default async function SignupPage() {
  if (!(await isSignupOpen())) {
    const t = await getT(messages);

    return (
      <Card className="shadow-raised">
        <CardHeader>
          <CardTitle className="text-lg">{t('signup.closed.title')}</CardTitle>
          <CardDescription>{t('signup.closed.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="info">
            {t('signup.closed.hint')}{' '}
            <code className="font-mono text-xs">ALLOW_SIGNUP=true</code>.
          </Alert>
          <Link
            href="/login"
            className="text-sm text-signal underline decoration-signal-edge underline-offset-4 hover:decoration-signal"
          >
            {t('link.backToLogin')}
          </Link>
        </CardContent>
      </Card>
    );
  }

  return <SignupForm />;
}
