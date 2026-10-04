'use client';

import { Badge } from '@/components/ui/badge';
import { useT } from '@/i18n/client';
import { applications as messages } from '@/i18n/messages/applications';
import { withSlot } from '@/lib/rich';
import type { ApplicationRow } from './applications-view';

/**
 * "What will run": one service per row, read from the AppSpec — port, health,
 * dependencies, volumes, secrets —, then the exposure. It is what one reviews
 * before deploying, in the drawer as on the record.
 */
export function ServiceList({ application }: { application: Pick<ApplicationRow, 'services' | 'ingress'> }) {
  const t = useT(messages);
  return (
    <>
      <div className="card card-flat overflow-hidden">
        <ul className="list">
          {application.services.map((service) => {
            const parts = [
              service.exposed
                ? t('drawer.service.port', { port: service.port })
                : t('drawer.service.internal', { port: service.port }),
              service.health
                ? t('drawer.service.health', {
                    path: service.health.path,
                    interval: service.health.interval,
                    retries: service.health.retries,
                  })
                : null,
              service.replicas > 1 ? t('drawer.service.replicas', { count: service.replicas }) : null,
              service.dependsOn.length > 0
                ? t('drawer.service.depends', { list: service.dependsOn.join(', ') })
                : null,
              service.volumes.length > 0
                ? t('drawer.service.volumes', { list: service.volumes.join(', ') })
                : null,
              service.secrets.length > 0
                ? t('drawer.service.secrets', { list: service.secrets.join(', ') })
                : null,
            ].filter(Boolean);
            return (
              <li key={service.name} className="flex-col !items-start gap-0.5 py-2.5">
                <span className="flex items-center gap-2">
                  <span className="mono text-[12.5px] font-semibold">{service.name}</span>
                  {service.exposed ? <Badge variant="accent">{t('drawer.exposed')}</Badge> : null}
                </span>
                <span className="t-cap text-text-3">{parts.join(' · ')}</span>
              </li>
            );
          })}
        </ul>
      </div>
      <span className="t-cap text-text-3">
        {application.ingress?.host ? (
          <>
            {withSlot(
              (slot) => t('drawer.ingress', { host: slot, service: application.ingress?.service ?? '' }),
              <span className="mono">{application.ingress.host}</span>,
            )}
            {application.ingress.tls ? ' (TLS)' : ''}
          </>
        ) : (
          t('detail.spec.byPort')
        )}
      </span>
    </>
  );
}
