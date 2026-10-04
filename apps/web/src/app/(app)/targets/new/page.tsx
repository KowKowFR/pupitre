import { redirect } from 'next/navigation';
import { requirePagePermission } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

/**
 * Adding a target happens in a drawer, above the list. This address stays valid
 * for the links and bookmarks that know it: it opens that drawer.
 */
export default async function NewTargetPage() {
  await requirePagePermission('/targets/new', 'target:create');
  redirect('/targets?add=new');
}
