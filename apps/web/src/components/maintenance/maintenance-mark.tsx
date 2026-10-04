import Link from 'next/link';
import { Wrench } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { maintenance as messages } from '@/i18n/messages/maintenance';
import { getT } from '@/i18n/server';
import type { FormatSettings } from '@/lib/format';
import type { CoverageBrief } from '@/lib/maintenance';
import { maintenanceWhen } from '@/lib/maintenance-format';

/**
 * At the top of a target's or a probe's record: it is under maintenance, until
 * when, and what that changes. Nothing when it is not. `canRead`: the link to the
 * window follows `maintenance:read`.
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
  // The window that ends the latest says when the alerts resume.
  const last = [...windows].sort((a, b) => b.endsAt.localeCompare(a.endsAt))[0];
  if (!last) return null;
  const t = await getT(messages);
  return (
    <Alert
      variant="warn"
      action={
        canRead ? (
          <Link href={`/maintenance?window=${last.id}` as never} className="btn btn-ghost btn-sm">
            {t('banner.open')}
          </Link>
        ) : undefined
      }
    >
      {t('mark.callout', { time: maintenanceWhen(last.endsAt, format), title: last.title })}
    </Alert>
  );
}

/** "Put under maintenance": the scheduling drawer, with this subject already checked. */
export async function ScheduleMaintenanceLink({
  subject,
  id,
}: {
  subject: 'target' | 'monitor';
  id: string;
}) {
  const t = await getT(messages);
  return (
    <Link href={`/maintenance?new=1&${subject}=${id}` as never} className="btn btn-secondary">
      <Wrench aria-hidden />
      {t('action.schedule')}
    </Link>
  );
}
