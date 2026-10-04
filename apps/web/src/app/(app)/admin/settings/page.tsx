import { redirect } from 'next/navigation';
import { requirePagePermission } from '@/lib/page-auth';
import { SETTINGS_GROUPS, SETTINGS_ROOT, groupSections } from './sections';

export const dynamic = 'force-dynamic';

/**
 * `/admin/settings` leads to the first tab of the first group. The summary that
 * lived here — ten cards, each with its values — duplicated the sections without
 * adding anything: the groups and their tabs are enough to find one's way.
 *
 * The HTTP redirect is set in `next.config.ts`; this page only serves if it is
 * reached otherwise (client-side navigation).
 */
export default async function SettingsRootPage() {
  await requirePagePermission(SETTINGS_ROOT, 'settings:read');
  const first = SETTINGS_GROUPS[0] ? groupSections(SETTINGS_GROUPS[0])[0] : undefined;
  redirect((first?.href ?? '/admin/settings/identite') as never);
}
