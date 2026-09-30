import Link from 'next/link';
import type { AuditLogPage } from '@pupitre/db';
import type { Translate } from '@pupitre/core';
import { EmptyState } from '@/components/empty-state';
import { Badge, CodeBadge } from '@/components/ui/badge';
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { admin } from '@/i18n/messages/admin';
import { common } from '@/i18n/messages/common';
import { getT } from '@/i18n/server';
import { createDateFormatter, type FormatSettings } from '@/lib/format';

const DENIAL_ACTIONS = new Set(['permission.denied', 'auth.login.failed', 'auth.signup.blocked']);

/**
 * Le journal se lit, il ne se traduit pas.
 *
 * Une entrée ne porte que des données : un nom d'action (`deployment.created`),
 * un type de ressource, un identifiant, une IP, une charge utile JSON. Aucune
 * n'est de la prose, et traduire à l'écriture aurait figé la langue de la trace
 * pour toujours. Ce qui se traduit ici, c'est le décor : en-têtes, pagination,
 * état vide, « système / anonyme », la note de fuseau.
 */
export async function AuditTable({ page, format }: { page: AuditLogPage; format: FormatSettings }) {
  const t = await getT(admin);
  const c = await getT(common);

  // Un seul formateur pour toute la table plutôt qu'un `Intl.DateTimeFormat`
  // reconstruit à chaque ligne.
  const formatDate = createDateFormatter(format);

  if (page.items.length === 0) {
    return <EmptyState title={t('logs.empty.title')} hint={t('logs.empty.hint')} />;
  }

  return (
    <Card className="py-4">
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{c('column.date')}</TableHead>
              <TableHead>{t('logs.column.actor')}</TableHead>
              <TableHead>{t('logs.column.action')}</TableHead>
              <TableHead>{t('logs.column.resource')}</TableHead>
              <TableHead>{t('logs.column.ip')}</TableHead>
              <TableHead>{c('column.detail')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.items.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="font-mono text-xs whitespace-nowrap text-text-2 tabular-nums">
                  {formatDate(item.createdAt)}
                </TableCell>
                <TableCell className="text-xs text-text">
                  {item.actorEmail ?? (
                    <span className="text-text-3 italic">{t('logs.anonymous')}</span>
                  )}
                </TableCell>
                <TableCell>
                  {DENIAL_ACTIONS.has(item.action) ? (
                    <Badge variant="destructive" className="font-mono">
                      {item.action}
                    </Badge>
                  ) : (
                    <CodeBadge>{item.action}</CodeBadge>
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  <span className="text-text-2">{item.resourceType}</span>
                  {item.resourceId ? (
                    <span className="font-mono text-text-3"> · {item.resourceId}</span>
                  ) : null}
                </TableCell>
                <TableCell className="font-mono text-xs text-text-3">
                  {item.ip ?? c('none')}
                </TableCell>
                <TableCell className="max-w-xs truncate font-mono text-[0.6875rem] text-text-3">
                  {item.after ? JSON.stringify(item.after) : c('none')}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <p className="text-text-3 text-xs">{t('logs.timezone', { timezone: format.timezone })}</p>
      </CardContent>

      <Pagination page={page} c={c} />
    </Card>
  );
}

function Pagination({ page, c }: { page: AuditLogPage; c: Translate<typeof common.fr> }) {
  if (page.totalPages <= 1) return null;

  const link = (target: number) => `/admin/logs?page=${target}&pageSize=${page.pageSize}`;

  return (
    <CardFooter className="flex items-center justify-between text-xs">
      <span className="font-mono text-text-3 tabular-nums">
        {c('page.position', { page: page.page, total: page.totalPages })}
      </span>
      <div className="flex gap-4">
        {page.page > 1 ? (
          <Link
            href={link(page.page - 1)}
            className="text-text-2 transition-colors hover:text-accent"
          >
            {c('page.previous')}
          </Link>
        ) : null}
        {page.page < page.totalPages ? (
          <Link
            href={link(page.page + 1)}
            className="text-text-2 transition-colors hover:text-accent"
          >
            {c('page.next')}
          </Link>
        ) : null}
      </div>
    </CardFooter>
  );
}
