import Link from 'next/link';
import type { AuditLogPage } from '@tp/db';
import { EmptyState } from '@/components/empty-state';
import { Badge, CodeBadge } from '@/components/ui/badge';
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { createDateFormatter, type FormatSettings } from '@/lib/format';

const DENIAL_ACTIONS = new Set(['permission.denied', 'auth.login.failed', 'auth.signup.blocked']);

export function AuditTable({ page, format }: { page: AuditLogPage; format: FormatSettings }) {
  // Un seul formateur pour toute la table plutôt qu'un `Intl.DateTimeFormat`
  // reconstruit à chaque ligne.
  const formatDate = createDateFormatter(format);

  if (page.items.length === 0) {
    return (
      <EmptyState
        title="Aucune entrée"
        hint="Aucun événement ne correspond à ces filtres. Élargissez la plage de dates ou effacez le filtre d'action."
      />
    );
  }

  return (
    <Card className="py-4">
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date ({format.timezone})</TableHead>
              <TableHead>Acteur</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Ressource</TableHead>
              <TableHead>IP</TableHead>
              <TableHead>Détail</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.items.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="font-mono text-xs whitespace-nowrap text-ink-muted tabular-nums">
                  {formatDate(item.createdAt)}
                </TableCell>
                <TableCell className="text-xs text-ink">
                  {item.actorEmail ?? (
                    <span className="text-ink-faint italic">système / anonyme</span>
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
                  <span className="text-ink-muted">{item.resourceType}</span>
                  {item.resourceId ? (
                    <span className="font-mono text-ink-faint"> · {item.resourceId}</span>
                  ) : null}
                </TableCell>
                <TableCell className="font-mono text-xs text-ink-faint">{item.ip ?? '—'}</TableCell>
                <TableCell className="max-w-xs truncate font-mono text-[0.6875rem] text-ink-faint">
                  {item.after ? JSON.stringify(item.after) : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>

      <Pagination page={page} />
    </Card>
  );
}

function Pagination({ page }: { page: AuditLogPage }) {
  if (page.totalPages <= 1) return null;

  const link = (target: number) => `/admin/audit?page=${target}&pageSize=${page.pageSize}`;

  return (
    <CardFooter className="flex items-center justify-between text-xs">
      <span className="font-mono text-ink-faint tabular-nums">
        Page {page.page} sur {page.totalPages}
      </span>
      <div className="flex gap-4">
        {page.page > 1 ? (
          <Link
            href={link(page.page - 1)}
            className="text-ink-muted transition-colors hover:text-signal"
          >
            ← Précédente
          </Link>
        ) : null}
        {page.page < page.totalPages ? (
          <Link
            href={link(page.page + 1)}
            className="text-ink-muted transition-colors hover:text-signal"
          >
            Suivante →
          </Link>
        ) : null}
      </div>
    </CardFooter>
  );
}
