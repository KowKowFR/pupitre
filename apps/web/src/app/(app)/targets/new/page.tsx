import { redirect } from 'next/navigation';
import { requirePagePermission } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

/**
 * L'ajout d'une cible se fait dans un tiroir, au-dessus de la liste. Cette
 * adresse reste valable pour les liens et favoris qui la connaissent : elle
 * ouvre ce tiroir.
 */
export default async function NewTargetPage() {
  await requirePagePermission('/targets/new', 'target:create');
  redirect('/targets?add=new');
}
