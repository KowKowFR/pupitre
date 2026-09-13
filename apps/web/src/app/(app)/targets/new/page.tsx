import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { TargetHelpDialog } from '@/components/target-help';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getT } from '@/i18n/server';
import { targets as messages } from '@/i18n/messages/targets';
import { requirePagePermission } from '@/lib/page-auth';
import { TargetForm } from '../target-form';

export const dynamic = 'force-dynamic';

export default async function NewTargetPage() {
  await requirePagePermission('/targets/new', 'target:create');
  const t = await getT(messages);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={
          <Link
            href="/targets"
            className="inline-flex items-center gap-1 transition-colors hover:text-ink"
          >
            <ChevronLeft className="size-3" />
            {t('nav.back')}
          </Link>
        }
        title={t('page.add')}
        description={t('new.description')}
      />

      {/* Le formulaire demande une machine, un compte, une clé, une plage de
          ports — sans jamais dire ce qu'il faut avoir préparé en face. La
          modale le dit, et reste à portée du champ qu'on est en train de
          remplir. */}
      <TargetHelpDialog />

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>{t('card.connection')}</CardTitle>
          <CardDescription>{t('new.card.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <TargetForm />
        </CardContent>
      </Card>
    </div>
  );
}
