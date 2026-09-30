import { auditQuerySchema, getAppSettings, listAuditActors, listAuditLogs } from '@pupitre/db';
import { Download } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { admin } from '@/i18n/messages/admin';
import { getT } from '@/i18n/server';
import { expandDayRange } from '@/lib/day-range';
import { formatSettingsOf } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import { AuditView } from './audit-view';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function AuditPage({ searchParams }: { searchParams: SearchParams }) {
  await requirePagePermission('/admin/logs', 'audit:read');
  const t = await getT(admin);

  const raw = await searchParams;
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const single = Array.isArray(value) ? value[0] : value;
    if (single !== undefined && single !== '') flat[key] = single;
  }

  // Les jours du filtre se lisent dans le fuseau de l'instance, « Au » compris.
  const { settings } = await getAppSettings();
  const parsed = auditQuerySchema.safeParse(expandDayRange(flat, settings.timezone));
  const query = parsed.success ? parsed.data : auditQuerySchema.parse({});
  const [page, actors] = await Promise.all([listAuditLogs(query), listAuditActors()]);

  // L'export reprend les filtres affichés, toutes pages confondues.
  const exportParams = new URLSearchParams();
  for (const key of ['action', 'resourceType', 'actorId', 'from', 'to'] as const) {
    if (flat[key]) exportParams.set(key, flat[key]);
  }
  const exportQuery = exportParams.toString();

  return (
    <>
      <PageHeader
        title={t('logs.title')}
        description={
          <>
            {t('logs.description.before')} <code className="mono">logAudit()</code>{' '}
            {t('logs.description.after')}
          </>
        }
        actions={
          <>
            <span className="mono t-cap text-text-3">
              {t('logs.summary', {
                count: page.total,
                page: page.page,
                total: page.totalPages,
              })}
            </span>
            {page.total > 0 ? (
              <Button asChild variant="secondary">
                <a href={`/api/audit-logs/export${exportQuery ? `?${exportQuery}` : ''}`} download>
                  <Download aria-hidden />
                  {t('logs.export')}
                </a>
              </Button>
            ) : null}
          </>
        }
      />

      <AuditView
        items={page.items.map((item) => ({
          id: item.id,
          createdAt: item.createdAt.toISOString(),
          actorId: item.actorId,
          actorEmail: item.actorEmail,
          action: item.action,
          resourceType: item.resourceType,
          resourceId: item.resourceId,
          ip: item.ip,
          userAgent: item.userAgent,
          before: item.before,
          after: item.after,
        }))}
        page={{ page: page.page, totalPages: page.totalPages, pageSize: page.pageSize }}
        actors={actors.map((actor) => ({ id: actor.id, email: actor.email }))}
        filters={{
          actorId: flat.actorId ?? '',
          action: flat.action ?? '',
          resourceType: flat.resourceType ?? '',
          from: flat.from ?? '',
          to: flat.to ?? '',
        }}
        format={formatSettingsOf(settings)}
      />
    </>
  );
}
