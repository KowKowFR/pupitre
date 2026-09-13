import Link from 'next/link';
import type { FirewallInfo, Translate } from '@pupitre/core';
import type { TargetPortReport } from '@pupitre/db';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getT } from '@/i18n/server';
import { targets as messages } from '@/i18n/messages/targets';
import { cn } from '@/lib/utils';

/**
 * Allocation de ports d'une cible.
 *
 * Deux questions, une réponse : « combien reste-t-il ? » et « qui a quoi ? ».
 * La jauge répond à la première d'un coup d'œil, la table à la seconde. Le
 * pare-feu est là aussi parce qu'un port alloué mais fermé est un port qui ne
 * sert à rien — l'information n'a de sens qu'à côté de l'autre.
 */
export async function PortsPanel({
  report,
  firewall,
}: {
  report: TargetPortReport;
  firewall: FirewallInfo | null;
}) {
  const t = await getT(messages);
  const ratio = report.capacity === 0 ? 0 : report.used / report.capacity;
  const percent = Math.round(ratio * 100);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('ports.title')}</CardTitle>
        {/* Trois fragments, deux pluriels indépendants : « 1 occupé sur 10 » et
            « 9 libres » ne s'accordent pas ensemble. */}
        <CardDescription>
          {t('ports.range', { min: report.range.min, max: report.range.max })} ·{' '}
          {t('ports.used', { count: report.used, capacity: report.capacity })} ·{' '}
          {t('ports.free', { count: report.free })}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
            <div
              className={cn(
                'h-full rounded-full transition-[width]',
                ratio >= 0.9 ? 'bg-danger' : ratio >= 0.7 ? 'bg-warn' : 'bg-ok',
              )}
              // Une jauge se dessine, elle ne se raconte pas : la largeur est la
              // seule chose ici qui dépende d'une donnée, d'où le style inline.
              style={{ width: `${Math.min(100, Math.max(percent, report.used > 0 ? 2 : 0))}%` }}
            />
          </div>
          <div className="text-muted-foreground mt-1 flex justify-between font-mono text-[10px]">
            <span>{report.range.min}</span>
            <span>{percent}%</span>
            <span>{report.range.max}</span>
          </div>
        </div>

        <FirewallLine firewall={firewall} t={t} />

        {report.allocations.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('ports.empty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">{t('ports.column.port')}</TableHead>
                <TableHead>{t('ports.column.application')}</TableHead>
                <TableHead>{t('ports.column.lastDeployment')}</TableHead>
                <TableHead>{t('ports.column.reservedAt')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.allocations.map((allocation) => {
                const outOfRange =
                  allocation.port < report.range.min || allocation.port > report.range.max;

                return (
                  <TableRow key={allocation.port}>
                    <TableCell className="font-mono text-xs">
                      {allocation.port}
                      {outOfRange ? (
                        <Badge variant="outline" className="ml-2 text-[10px]">
                          {t('ports.outOfRange')}
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm">
                      <Link
                        href={`/applications/${allocation.applicationId}`}
                        className="underline underline-offset-4"
                      >
                        {allocation.applicationSlug}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {allocation.deploymentId ? (
                        <Link
                          href={`/deployments/${allocation.deploymentId}`}
                          className="underline underline-offset-4"
                        >
                          {allocation.deploymentStatus}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground font-mono text-xs">
                      {allocation.reservedAt.toISOString().slice(0, 16).replace('T', ' ')}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        {report.freeSample.length > 0 ? (
          <p className="text-muted-foreground font-mono text-[11px]">
            {t('ports.freeSample', { list: report.freeSample.slice(0, 10).join(', ') })}
            {report.free > 10 ? ' …' : ''}
          </p>
        ) : (
          <p className="text-destructive text-xs">{t('ports.exhausted')}</p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * État du pare-feu, tel que le dernier preflight l'a vu.
 *
 * « installé mais inactif » n'est pas une erreur : le panel n'active jamais un
 * pare-feu de sa propre initiative — couper le filtrage d'une machine qu'on
 * pilote en SSH est le meilleur moyen de la perdre. Il le signale, c'est tout.
 */
function FirewallLine({
  firewall,
  t,
}: {
  firewall: FirewallInfo | null;
  t: Translate<typeof messages.fr>;
}) {
  if (!firewall) {
    return <p className="text-muted-foreground text-xs">{t('firewall.unknown')}</p>;
  }

  if (!firewall.installed) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="outline">{t('firewall.absent.badge')}</Badge>
        <span className="text-muted-foreground">{t('firewall.absent.text')}</span>
      </div>
    );
  }

  if (!firewall.active) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="warn">{t('firewall.inactive.badge')}</Badge>
        <span className="text-muted-foreground">{t('firewall.inactive.text')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="secondary">{t('firewall.active.badge')}</Badge>
        <span className="text-muted-foreground">
          {t('firewall.rules', { count: firewall.managedRules.length })}
        </span>
      </div>
      {firewall.managedRules.length > 0 ? (
        <pre className="bg-muted/40 overflow-x-auto rounded-md border p-2 font-mono text-[10px]">
          {firewall.managedRules.join('\n')}
        </pre>
      ) : null}
    </div>
  );
}
