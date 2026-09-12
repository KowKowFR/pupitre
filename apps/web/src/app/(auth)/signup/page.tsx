import type { Metadata } from 'next';
import Link from 'next/link';
import { isSignupOpen } from '@/lib/auth';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SignupForm } from './signup-form';

export const metadata: Metadata = { title: 'Inscription — Pupitre' };
export const dynamic = 'force-dynamic';

export default async function SignupPage() {
  if (!(await isSignupOpen())) {
    return (
      <Card className="shadow-raised">
        <CardHeader>
          <CardTitle className="text-lg">Inscription fermée</CardTitle>
          <CardDescription>
            L&apos;inscription publique est désactivée sur cette instance.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="info">
            Demandez un compte à un administrateur, ou activez{' '}
            <code className="font-mono text-xs">ALLOW_SIGNUP=true</code>.
          </Alert>
          <Link
            href="/login"
            className="text-sm text-signal underline decoration-signal-edge underline-offset-4 hover:decoration-signal"
          >
            Retour à la connexion
          </Link>
        </CardContent>
      </Card>
    );
  }

  return <SignupForm />;
}
