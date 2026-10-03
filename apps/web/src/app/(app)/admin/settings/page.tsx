import { redirect } from 'next/navigation';
import { requirePagePermission } from '@/lib/page-auth';
import { SETTINGS_GROUPS, SETTINGS_ROOT, groupSections } from './sections';

export const dynamic = 'force-dynamic';

/**
 * `/admin/settings` mène au premier onglet du premier groupe. Le sommaire qui
 * vivait ici — dix cartes, chacune avec ses valeurs — doublait les sections
 * sans rien y ajouter : les groupes et leurs onglets suffisent à s'y retrouver.
 *
 * La redirection HTTP est posée dans `next.config.ts` ; cette page ne sert
 * que si on l'atteint autrement (navigation côté client).
 */
export default async function SettingsRootPage() {
  await requirePagePermission(SETTINGS_ROOT, 'settings:read');
  const first = SETTINGS_GROUPS[0] ? groupSections(SETTINGS_GROUPS[0])[0] : undefined;
  redirect((first?.href ?? '/admin/settings/identite') as never);
}
