import Link from 'next/link';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export default async function ForbiddenPage({
  searchParams,
}: {
  searchParams: Promise<{ permission?: string }>;
}) {
  const { permission } = await searchParams;

  return (
    <div className="mx-auto flex min-h-dvh max-w-md items-center p-6">
      <Card className="w-full border-danger-edge shadow-raised">
        <CardHeader>
          <CardTitle className="text-lg">Accès refusé</CardTitle>
          <CardDescription>Votre rôle ne permet pas d&apos;ouvrir cette page.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {permission ? (
            <Alert variant="destructive">
              Permission requise : <code className="font-mono text-xs">{permission}</code>
            </Alert>
          ) : null}
          <p className="text-[0.8125rem] text-ink-muted">
            La tentative a été enregistrée dans le journal d&apos;audit.
          </p>
          <Link
            href="/"
            className="text-sm text-signal underline decoration-signal-edge underline-offset-4 hover:decoration-signal"
          >
            Retour au tableau de bord
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
