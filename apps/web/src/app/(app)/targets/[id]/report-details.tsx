import type { PreflightReport } from '@pupitre/core';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function gib(kb: number): string {
  return `${(kb / 1024 / 1024).toFixed(1)} Gio`;
}

export function ReportDetails({ report }: { report: PreflightReport | null }) {
  if (!report) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Rapport de preflight</CardTitle>
          <CardDescription>
            Aucun preflight n&apos;a encore été lancé sur cette cible.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {report.error ? (
        <Card>
          <CardHeader>
            <CardTitle>Cible injoignable</CardTitle>
            <CardDescription className="font-mono text-xs text-danger">
              {report.error}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Machine</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Système">{report.os.prettyName ?? report.os.name ?? '—'}</Row>
            <Row label="Noyau">{report.os.uname ?? '—'}</Row>
            <Row label="Latence SSH">
              {report.latencyMs === null ? '—' : `${report.latencyMs} ms`}
            </Row>
            <Row label="sudo">
              {report.sudo.nopasswd
                ? 'sans mot de passe'
                : report.sudo.available
                  ? 'mot de passe requis'
                  : 'indisponible'}
            </Row>
            <Row label="Disque /">
              {report.disk
                ? `${gib(report.disk.availableKb)} libres sur ${gib(report.disk.sizeKb)} (${report.disk.usePercent} %)`
                : '—'}
            </Row>
            <Row label="Mémoire">
              {report.memory
                ? `${report.memory.availableMb} Mio disponibles sur ${report.memory.totalMb}`
                : '—'}
            </Row>
            <Row label="Outils">
              <span className="flex flex-wrap gap-1">
                {Object.entries(report.tools).map(([tool, present]) => (
                  <Badge key={tool} variant={present ? 'ok' : 'outline'} className="font-mono">
                    {tool} {present ? '✓' : '✗'}
                  </Badge>
                ))}
              </span>
            </Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Runtimes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Docker">
              {report.runtimes.docker.available
                ? `✓ ${report.runtimes.docker.version ?? ''}`
                : '✗ indisponible'}
            </Row>
            <Row label="Docker Compose">{report.runtimes.docker.composeVersion ?? '—'}</Row>
            <Row label="K3s / Kubernetes">
              {report.runtimes.k3s.available
                ? `✓ ${report.runtimes.k3s.version ?? ''}`
                : '✗ indisponible'}
            </Row>
            <Row label="Nodes prêts">
              {report.runtimes.k3s.nodes === null
                ? '—'
                : `${report.runtimes.k3s.readyNodes ?? 0} / ${report.runtimes.k3s.nodes}`}
            </Row>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Contrôles</CardTitle>
          <CardDescription>
            Chaque contrôle est indépendant : un échec n&apos;invalide pas les autres.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Contrôle</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead>Durée</TableHead>
                <TableHead>Détail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.checks.map((check) => (
                <TableRow key={check.key}>
                  <TableCell className="text-sm">{check.label}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        check.status === 'success'
                          ? 'ok'
                          : check.status === 'failed'
                            ? 'destructive'
                            : 'warn'
                      }
                      className="font-mono"
                    >
                      {check.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-ink-muted tabular-nums">
                    {check.durationMs} ms
                  </TableCell>
                  <TableCell className="font-mono text-xs text-ink-faint">
                    {check.error ?? check.detail ?? '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2 last:border-0">
      <span className="text-xs text-ink-muted">{label}</span>
      <span className="font-mono text-xs text-ink">{children}</span>
    </div>
  );
}
