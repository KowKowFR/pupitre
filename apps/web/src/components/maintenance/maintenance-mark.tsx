import Link from 'next/link';
import { Wrench } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { maintenance as messages } from '@/i18n/messages/maintenance';
import { getT } from '@/i18n/server';
import type { FormatSettings } from '@/lib/format';
import type { CoverageBrief } from '@/lib/maintenance';
import { maintenanceWhen } from '@/lib/maintenance-format';

/**
 * En tête de la fiche d'une cible ou d'une sonde : elle est en maintenance,
 * jusqu'à quand, et ce que cela change. Rien quand elle ne l'est pas.
 * `canRead` : le lien vers la fenêtre suit `maintenance:read`.
 */
export async function MaintenanceMark({
  windows,
  format,
  canRead,
}: {
  windows: CoverageBrief[];
  format: FormatSettings;
  canRead: boolean;
}) {
  // La fenêtre qui finit le plus tard dit quand les alertes reprennent.
  const last = [...windows].sort((a, b) => b.endsAt.localeCompare(a.endsAt))[0];
  if (!last) return null;
  const t = await getT(messages);
  return (
    <Alert
      variant="warn"
      action={
        canRead ? (
          <Link href={`/maintenance?fenetre=${last.id}` as never} className="btn btn-ghost btn-sm">
            {t('banner.open')}
          </Link>
        ) : undefined
      }
    >
      {t('mark.callout', { time: maintenanceWhen(last.endsAt, format), title: last.title })}
    </Alert>
  );
}

/** « Mettre en maintenance » : le tiroir de planification, ce sujet déjà coché. */
export async function ScheduleMaintenanceLink({
  subject,
  id,
}: {
  subject: 'cible' | 'sonde';
  id: string;
}) {
  const t = await getT(messages);
  return (
    <Link href={`/maintenance?nouvelle=1&${subject}=${id}` as never} className="btn btn-secondary">
      <Wrench aria-hidden />
      {t('action.schedule')}
    </Link>
  );
}
