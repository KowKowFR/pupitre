import Link from 'next/link';
import { Wrench } from 'lucide-react';
import { Led } from '@/components/instrument';
import { maintenance as messages } from '@/i18n/messages/maintenance';
import { getT } from '@/i18n/server';
import type { FormatSettings } from '@/lib/format';
import type { MaintenanceWindowJson } from '@/lib/maintenance';
import { maintenanceWhen } from '@/lib/maintenance-format';
import { cn } from '@/lib/utils';

/**
 * La bande de la vue d'ensemble : ce qui est en maintenance maintenant, et ce
 * qui le sera dans la journée. Elle passe avant le bloc d'attention — une
 * panne sur une machine en maintenance n'a pas le même poids qu'une autre.
 *
 * Rien quand il n'y a rien. Chaque fenêtre ne montre que les sujets que la
 * session peut lire ; une fenêtre dont elle ne lit aucun sujet n'apparaît pas.
 */
export async function MaintenanceBanner({
  windows,
  format,
  canRead,
}: {
  windows: MaintenanceWindowJson[];
  format: FormatSettings;
  canRead: boolean;
}) {
  if (windows.length === 0) return null;
  const t = await getT(messages);
  const active = windows.filter((window) => window.phase === 'active');

  return (
    <section
      aria-labelledby="maintenance-title"
      className="card overflow-hidden"
      style={{
        boxShadow: `inset 3px 0 0 var(--${active.length > 0 ? 'warn' : 'accent'}), var(--sh-xs)`,
      }}
    >
      <div className="card-h flex-wrap">
        <span
          aria-hidden
          className={cn(
            'dlg-icon !size-7 !rounded-lg',
            active.length > 0 ? 'is-warn' : 'is-accent',
          )}
        >
          <Wrench className="!size-3.5" />
        </span>
        <h2 id="maintenance-title">
          {active.length > 0
            ? t('banner.active', { count: active.length })
            : t('banner.upcomingOnly', { count: windows.length })}
        </h2>
        {active.length > 0 ? (
          <span className="t-cap ml-auto text-text-3">{t('banner.aside')}</span>
        ) : null}
      </div>
      <ul className={cn('list', canRead && 'is-link')}>
        {windows.map((window) => (
          <li key={window.id} className="relative flex-wrap gap-y-1 sm:flex-nowrap">
            <span className="flex w-3.5 justify-center">
              <Led
                tone={window.phase === 'active' ? 'warn' : 'accent'}
                pulse={window.phase === 'active'}
              />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="t-sm text-text">
                {window.phase === 'active'
                  ? t('banner.until', {
                      title: window.title,
                      time: maintenanceWhen(window.endsAt, format),
                    })
                  : t('banner.upcoming', {
                      title: window.title,
                      date: maintenanceWhen(window.startsAt, format),
                    })}
              </span>
              <span className="mono t-cap truncate text-text-2">
                {[...window.targets, ...window.monitors].map((subject) => subject.name).join(' · ')}
                {window.phase === 'active' && window.held > 0
                  ? ` — ${t('row.held', { count: window.held })}`
                  : ''}
              </span>
            </span>
            {canRead ? (
              <Link
                href={`/maintenance?fenetre=${window.id}` as never}
                className="btn btn-ghost btn-sm shrink-0 after:absolute after:inset-0 max-sm:ml-[26px]"
              >
                {t('banner.open')}
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
