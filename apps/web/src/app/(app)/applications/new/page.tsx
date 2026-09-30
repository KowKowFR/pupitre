import { redirect } from 'next/navigation';
import { requirePagePermission } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

/**
 * La création d'une application se fait dans un tiroir, au-dessus de la liste.
 * Cette adresse reste valable pour les liens et favoris qui la connaissent :
 * elle ouvre ce tiroir.
 */
export default async function NewApplicationPage() {
  await requirePagePermission('/applications/new', 'application:create');
  redirect('/applications?add=new');
}
