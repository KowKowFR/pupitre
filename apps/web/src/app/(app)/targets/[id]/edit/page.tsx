import { notFound } from 'next/navigation';
import { getTarget } from '@pupitre/db';
import { z } from 'zod';
import { PageHeader } from '@/components/page-header';
import { Crumb } from '@/components/shell/breadcrumb';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getT } from '@/i18n/server';
import { targets as messages } from '@/i18n/messages/targets';
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
  const t = await getT(messages);

  return (
    <div className="flex flex-col gap-6">
      <Crumb label={target.name} />
      <PageHeader
        title={t('edit.title', { name: target.name })}
        description={t('edit.description')}
      />

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>{t('card.connection')}</CardTitle>
          <CardDescription>{t('edit.card.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          {/* `target` vient de `getTarget`, qui ne sélectionne pas la colonne
              chiffrée : le formulaire ne peut pas recevoir de credential. */}
          <TargetForm
            initial={{
              id: target.id,
              name: target.name,
              description: target.description,
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
