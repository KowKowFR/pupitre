import Link from 'next/link';
import type { FirewallInfo } from '@pupitre/core';
import type { TargetPortReport } from '@pupitre/db';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

/**
 * Allocation de ports d'une cible.
 *
 * Deux questions, une réponse : « combien reste-t-il ? » et « qui a quoi ? ».
 * La jauge répond à la première d'un coup d'œil, la table à la seconde. Le
 * pare-feu est là aussi parce qu'un port alloué mais fermé est un port qui ne
 * sert à rien — l'information n'a de sens qu'à côté de l'autre.
 */
export function PortsPanel({
  report,
  firewall,
}: {
  report: TargetPortReport;
  firewall: FirewallInfo | null;
}) {
  const ratio = report.capacity === 0 ? 0 : report.used / report.capacity;
  const percent = Math.round(ratio * 100);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ports alloués</CardTitle>
        <CardDescription>
          Plage {report.range.min}–{report.range.max} · {report.used} occupé
          {report.used > 1 ? 's' : ''} sur {report.capacity} · {report.free} libre
          {report.free > 1 ? 's' : ''}
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

        <FirewallLine firewall={firewall} />

        {report.allocations.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Aucun port réservé sur cette cible.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">Port</TableHead>
                <TableHead>Application</TableHead>
                <TableHead>Dernier déploiement</TableHead>
                <TableHead>Réservé le</TableHead>
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
                          hors plage
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
            Prochains ports libres : {report.freeSample.slice(0, 10).join(', ')}
            {report.free > 10 ? ' …' : ''}
          </p>
        ) : (
          <p className="text-destructive text-xs">
            Plus aucun port libre dans la plage : élargissez-la avant de déployer.
          </p>
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
function FirewallLine({ firewall }: { firewall: FirewallInfo | null }) {
  if (!firewall) {
    return (
      <p className="text-muted-foreground text-xs">
        État du pare-feu inconnu — lancez un preflight.
      </p>
    );
  }

  if (!firewall.installed) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="outline">ufw absent</Badge>
        <span className="text-muted-foreground">
          Les ports publiés ne sont filtrés par personne.
        </span>
      </div>
    );
  }

  if (!firewall.active) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="warn">
          ufw inactif
        </Badge>
        <span className="text-muted-foreground">
          Installé mais désactivé : le panel n&apos;y pose aucune règle et ne l&apos;active pas.
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="secondary">ufw actif</Badge>
        <span className="text-muted-foreground">
          {firewall.managedRules.length} règle{firewall.managedRules.length > 1 ? 's' : ''} posée
          {firewall.managedRules.length > 1 ? 's' : ''} par le panel.
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
