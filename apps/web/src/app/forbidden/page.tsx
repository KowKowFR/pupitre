import Link from 'next/link';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { auth as messages } from '@/i18n/messages/auth';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

export default async function ForbiddenPage({
  searchParams,
}: {
  searchParams: Promise<{ permission?: string }>;
}) {
  const { permission } = await searchParams;
  const t = await getT(messages);

  return (
    <div className="mx-auto flex min-h-dvh max-w-md items-center p-6">
      <Card className="w-full border-danger-line shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg">{t('forbidden.title')}</CardTitle>
          <CardDescription>{t('forbidden.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {permission ? (
            <Alert variant="destructive">
              {t('forbidden.permission')} <code className="font-mono text-xs">{permission}</code>
            </Alert>
          ) : null}
          <p className="text-[0.8125rem] text-text-2">{t('forbidden.body')}</p>
          <Link
            href="/"
            className="text-sm text-accent underline decoration-accent-line underline-offset-4 hover:decoration-accent"
          >
            {t('link.backToDashboard')}
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
