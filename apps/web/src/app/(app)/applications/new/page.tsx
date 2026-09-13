import Link from 'next/link';
import { aiProviderDescriptor, resolveAiConfig } from '@pupitre/core/ai';
import { usableRuntimes } from '@pupitre/core';
import { getAiApiKey, getAppSettings, listTargets } from '@pupitre/db';
import { ChevronLeft } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
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
      <PageHeader
        eyebrow={
          <Link
            href="/applications"
            className="inline-flex items-center gap-1 transition-colors hover:text-ink"
          >
            <ChevronLeft className="size-3" />
            Applications
          </Link>
        }
        title="Nouvelle application"
        description="Cet écran produit une AppSpec et l'enregistre au catalogue — il ne touche à aucune machine tant que vous ne choisissez pas une cible plus bas. Le runtime n'entre pas dans la spec : c'est ici, au moment de déployer, qu'on tranche entre Docker Compose et K3s."
      />

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
