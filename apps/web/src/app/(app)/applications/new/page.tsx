import Link from 'next/link';
import { aiModelMismatch, aiProviderDescriptor, resolveAiConfig } from '@pupitre/core/ai';
import { usableRuntimes } from '@pupitre/core';
import { getAiApiKey, getAppSettings, listTargets } from '@pupitre/db';
import { ChevronLeft } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { currentLanguage, getT } from '@/i18n/server';
import { applications as messages } from '@/i18n/messages/applications';
import { getEnv } from '@/lib/env';
import { requirePagePermission } from '@/lib/page-auth';
import { NewApplicationForm } from './new-application-form';

export const dynamic = 'force-dynamic';

export default async function NewApplicationPage() {
  const auth = await requirePagePermission('/applications/new', 'application:create');
  const t = await getT(messages);

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
  // `resolveAiConfig()` compose son avertissement sans savoir à qui il parle —
  // il sert aussi le worker et les logs. On le recalcule ici, dans la langue de
  // l'instance, parce que celui-là s'affiche dans une `Alert`.
  const modelWarning = aiModelMismatch(ai.provider, ai.model, {
    baseUrl: ai.baseUrl,
    language: await currentLanguage(),
  });

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
            className="inline-flex items-center gap-1 transition-colors hover:text-text"
          >
            <ChevronLeft className="size-3" />
            {t('page.title')}
          </Link>
        }
        title={t('action.new')}
        description={t('new.description')}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t('new.card.title')}</CardTitle>
          <CardDescription>{t('new.card.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <NewApplicationForm
            aiEnabled={ai.enabled}
            provider={descriptor.label}
            model={ai.model}
            modelWarning={modelWarning}
            missingKeyVar={descriptor.envApiKeyVar}
            targets={deployTargets}
          />
        </CardContent>
      </Card>
    </div>
  );
}
