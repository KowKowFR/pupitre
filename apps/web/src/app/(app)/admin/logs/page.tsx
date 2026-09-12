import { auditQuerySchema, getAppSettings, listAuditLogs } from '@pupitre/db';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { formatSettingsOf } from '@/lib/format';
import { requirePagePermission } from '@/lib/page-auth';
import { AuditFilters } from './audit-filters';
import { AuditTable } from './audit-table';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function AuditPage({ searchParams }: { searchParams: SearchParams }) {
  await requirePagePermission('/admin/logs', 'audit:read');

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
        eyebrow="Traçabilité"
        title="Logs"
        description={
          <>
            Qui a fait quoi, quand et depuis quelle IP — les logs d&apos;activité du panel, à ne pas
            confondre avec les logs d&apos;un déploiement ni avec ceux d&apos;une application en
            marche, qui se lisent sur leurs écrans respectifs. Écrits exclusivement par{' '}
            <code className="font-mono text-xs">logAudit()</code> : un point d&apos;entrée unique,
            jamais un insert dispersé dans un handler. Les refus de permission y figurent au même
            titre que les actions abouties.
          </>
        }
        actions={
          <span className="font-mono text-xs text-ink-faint tabular-nums">
            {page.total} entrée{page.total > 1 ? 's' : ''} · page {page.page}/{page.totalPages}
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
