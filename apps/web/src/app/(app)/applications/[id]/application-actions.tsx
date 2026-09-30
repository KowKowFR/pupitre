'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Ellipsis, Rocket, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IconButton } from '@/components/ui/tooltip';
import { useT } from '@/i18n/client';
import { applications as messages } from '@/i18n/messages/applications';
import { toast } from '@/lib/toast';
import { DeleteApplicationDialog } from '../delete-dialog';

/**
 * Les gestes de la fiche d'une application : Déployer — qui ouvre l'aperçu du
 * catalogue sur son déploiement rapide — et la suppression, rangée dans le
 * menu, qui passe par le même dialogue que la liste.
 */
export function ApplicationActions({
  application,
  canDeploy,
  canDelete,
}: {
  application: { id: string; slug: string };
  canDeploy: boolean;
  canDelete: boolean;
}) {
  const t = useT(messages);
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  return (
    <>
      {canDeploy ? (
        <Button asChild>
          <Link href={`/applications?app=${encodeURIComponent(application.slug)}&deploy=1`}>
            <Rocket aria-hidden />
            {t('action.deploy')}
          </Link>
        </Button>
      ) : null}
      {canDelete ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label={t('detail.more')} variant="secondary">
              <Ellipsis />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem destructive onSelect={() => setDeleting(true)}>
              <Trash2 aria-hidden />
              {t('row.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {deleting ? (
        <DeleteApplicationDialog
          application={application}
          open
          onOpenChange={setDeleting}
          onDeleted={() => {
            toast({ title: t('toast.deleted', { slug: application.slug }), tone: 'ok' });
            router.push('/applications');
          }}
        />
      ) : null}
    </>
  );
}
