import { auditQuerySchema, getAppSettings, listAuditLogs } from '@pupitre/db';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { admin } from '@/i18n/messages/admin';
import { getT } from '@/i18n/server';
import { formatSettingsOf } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import { AuditFilters } from './audit-filters';
import { AuditTable } from './audit-table';

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
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('logs.title')}
        description={
          <>
            {t('logs.description.before')} <code className="font-mono text-xs">logAudit()</code>{' '}
            {t('logs.description.after')}
          </>
        }
        actions={
          <span className="font-mono text-xs text-text-3 tabular-nums">
            {t('logs.summary', {
              count: page.total,
              page: page.page,
              total: page.totalPages,
            })}
          </span>
        }
      />

      <Card>
        <CardContent>
          <AuditFilters
            defaults={{
              actorId: flat.actorId ?? '',
              action: flat.action ?? '',
              resourceType: flat.resourceType ?? '',
              from: flat.from ?? '',
              to: flat.to ?? '',
            }}
          />
        </CardContent>
      </Card>

      <AuditTable page={page} format={formatSettingsOf(settings)} />
    </div>
  );
}
