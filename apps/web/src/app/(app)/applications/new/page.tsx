import Link from 'next/link';
import { aiProviderDescriptor, resolveAiConfig } from '@tp/core/ai';
import { usableRuntimes } from '@tp/core';
import { getAiApiKey, getAppSettings, listTargets } from '@tp/db';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getEnv } from '@/lib/env';
import { requirePagePermission } from '@/lib/page-auth';
import { NewApplicationForm } from './new-application-form';

export const dynamic = 'force-dynamic';

export default async function NewApplicationPage() {
  const auth = await requirePagePermission('/applications/new', 'application:create');

  // La clé ne quitte pas le serveur : on ne transmet au client que le fait
  // qu'elle existe, le fournisseur et le nom du modèle — qui ne sont pas des
  // secrets. `process.env` plutôt que `getEnv()` pour les clés de fournisseurs :
  // quelle variable lire appartient au descripteur du fournisseur, pas au
  // schéma d'environnement du panel.
  getEnv();
  const { settings } = await getAppSettings();
  const ai = resolveAiConfig({
    settings: settings.ai,
    settingsApiKey: await getAiApiKey(),
    env: process.env,
  });
  const descriptor = aiProviderDescriptor(ai.provider);

  // Le parcours va jusqu'au déploiement : on propose les cibles dont le
  // preflight a montré un runtime, et rien d'autre.
  const targets = auth.can('deployment:create') ? await listTargets() : [];
  const deployTargets = targets
    .filter((target) => usableRuntimes(target.runtimesAvailable).length > 0)
    .map((target) => ({
      id: target.id,
      name: target.name,
      host: target.host,
      runtimes: usableRuntimes(target.runtimesAvailable),
    }));

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
            directement un JSON. Dans les deux cas, la proposition s&apos;affiche avant
            enregistrement, et Zod valide avant que quoi que ce soit n&apos;atteigne la base.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <NewApplicationForm
            aiEnabled={ai.enabled}
            provider={descriptor.label}
            model={ai.model}
            modelWarning={ai.modelWarning}
            missingKeyVar={descriptor.envApiKeyVar}
            targets={deployTargets}
          />
        </CardContent>
      </Card>
    </div>
  );
}
