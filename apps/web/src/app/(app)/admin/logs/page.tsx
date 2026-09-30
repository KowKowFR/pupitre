import { auditQuerySchema, getAppSettings, listAuditLogs } from '@pupitre/db';
import { PageHeader } from '@/components/page-header';
import { admin } from '@/i18n/messages/admin';
import { getT } from '@/i18n/server';
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

  const parsed = auditQuerySchema.safeParse(flat);
  const query = parsed.success ? parsed.data : auditQuerySchema.parse({});
  const [page, { settings }] = await Promise.all([listAuditLogs(query), getAppSettings()]);

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
          <span className="mono t-cap text-text-3">
            {t('logs.summary', {
              count: page.total,
              page: page.page,
              total: page.totalPages,
            })}
          </span>
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
          before: item.before,
          after: item.after,
        }))}
        page={{ page: page.page, totalPages: page.totalPages, pageSize: page.pageSize }}
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
