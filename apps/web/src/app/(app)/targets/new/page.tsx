import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { TargetHelpDialog } from '@/components/target-help';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requirePagePermission } from '@/lib/page-auth';
import { TargetForm } from '../target-form';

export const dynamic = 'force-dynamic';

export default async function NewTargetPage() {
  await requirePagePermission('/targets/new', 'target:create');

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={
          <Link
            href="/targets"
            className="inline-flex items-center gap-1 transition-colors hover:text-ink"
          >
            <ChevronLeft className="size-3" />
            Machines cibles
          </Link>
        }
        title="Ajouter une cible"
        description="Le panel se connectera en SSH à cette machine pour y déployer. Le credential est chiffré en base dès l'enregistrement."
      />

      {/* Le formulaire demande une machine, un compte, une clé, une plage de
          ports — sans jamais dire ce qu'il faut avoir préparé en face. La
          modale le dit, et reste à portée du champ qu'on est en train de
          remplir. */}
      <TargetHelpDialog />

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>Connexion</CardTitle>
          <CardDescription>
            Lancez un preflight après création pour découvrir les runtimes disponibles.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TargetForm />
        </CardContent>
      </Card>
    </div>
  );
}
