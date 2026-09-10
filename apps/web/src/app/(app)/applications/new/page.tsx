import Link from 'next/link';
import { resolveAiConfig } from '@tp/core/ai';
import { getAiApiKey, getAppSettings } from '@tp/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getEnv } from '@/lib/env';
import { requirePagePermission } from '@/lib/page-auth';
import { NewApplicationForm } from './new-application-form';

export const dynamic = 'force-dynamic';

export default async function NewApplicationPage() {
  await requirePagePermission('/applications/new', 'application:create');

  // La clé ne quitte pas le serveur : on ne transmet au client que le fait
  // qu'elle existe, et le nom du modèle — qui n'est pas un secret.
  const env = getEnv();
  const { settings } = await getAppSettings();
  const ai = resolveAiConfig({
    settings: settings.ai,
    settingsApiKey: await getAiApiKey(),
    envApiKey: env.OPENROUTER_API_KEY,
    envModel: env.OPENROUTER_MODEL,
  });
  const aiEnabled = ai.enabled;
  const model = ai.model;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link
          href="/applications"
          className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-4"
        >
          ← Applications
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Nouvelle application</h1>
        <p className="text-muted-foreground text-sm">
          Une application est une <code className="font-mono text-xs">AppSpec</code> — une
          description neutre, qui ne connaît ni Docker ni Kubernetes.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>AppSpec</CardTitle>
          <CardDescription>
            Décrivez l&apos;application et laissez le modèle proposer une spec, ou collez
            directement un JSON. Dans les deux cas, Zod valide avant enregistrement.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <NewApplicationForm aiEnabled={aiEnabled} model={model} />
        </CardContent>
      </Card>
    </div>
  );
}
