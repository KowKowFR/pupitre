import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { getTarget } from '@pupitre/db';
import { z } from 'zod';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requirePagePermission } from '@/lib/page-auth';
import { TargetForm } from '../../target-form';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });

export default async function EditTargetPage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();

  await requirePagePermission(`/targets/${parsed.data.id}/edit`, 'target:update');
  const target = await getTarget(parsed.data.id);
  if (!target) notFound();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={
          <Link
            href={`/targets/${target.id}`}
            className="inline-flex items-center gap-1 transition-colors hover:text-ink"
          >
            <ChevronLeft className="size-3" />
            {target.name}
          </Link>
        }
        title={`Modifier « ${target.name} »`}
        description="Ces réglages valent pour les prochaines connexions. Rien de ce qui tourne déjà sur cette machine n'est redéployé, et les ports déjà réservés le restent même si vous rétrécissez la plage. Après un changement d'hôte, de compte ou de clé, relancez un preflight : le relevé précédent reste affiché tel quel jusque-là."
      />

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>Connexion</CardTitle>
          <CardDescription>
            Le credential n&apos;est jamais pré-rempli : laissez le champ vide pour conserver
            celui déjà en base.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* `target` vient de `getTarget`, qui ne sélectionne pas la colonne
              chiffrée : le formulaire ne peut pas recevoir de credential. */}
          <TargetForm
            initial={{
              id: target.id,
              name: target.name,
              host: target.host,
              port: target.port,
              sshUser: target.sshUser,
              authMethod: target.authMethod,
              sudoMethod: target.sudoMethod,
              portRangeStart: target.portRangeStart,
              portRangeEnd: target.portRangeEnd,
              labels: target.labels,
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
