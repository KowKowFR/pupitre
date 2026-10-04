import { redirect } from 'next/navigation';
import { requirePagePermission } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

/**
 * Creating an application happens in a drawer, above the list. This address
 * stays valid for the links and bookmarks that know it: it opens that drawer.
 */
export default async function NewApplicationPage() {
  await requirePagePermission('/applications/new', 'application:create');
  redirect('/applications?add=new');
}
