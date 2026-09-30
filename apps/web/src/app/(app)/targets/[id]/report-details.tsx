import type { PreflightReport } from '@pupitre/core';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getT } from '@/i18n/server';
import { common } from '@/i18n/messages/common';
import { targets as messages } from '@/i18n/messages/targets';

/** L'unité voyage en argument : « Gio » n'est pas « GiB ». */
function gib(kb: number, unit: string): string {
  return `${(kb / 1024 / 1024).toFixed(1)} ${unit}`;
}

export async function ReportDetails({ report }: { report: PreflightReport | null }) {
  const t = await getT(messages);
  const tc = await getT(common);

  if (!report) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('report.title')}</CardTitle>
          <CardDescription>{t('report.none')}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {report.error ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('report.unreachable')}</CardTitle>
            <CardDescription className="font-mono text-xs text-danger-text">
              {report.error}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('report.machine')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label={t('row.os')}>{report.os.prettyName ?? report.os.name ?? tc('none')}</Row>
            <Row label={t('row.kernel')}>{report.os.uname ?? tc('none')}</Row>
            <Row label={t('row.latency')}>
              {report.latencyMs === null ? tc('none') : `${report.latencyMs} ms`}
            </Row>
            <Row label={t('row.sudo')}>
              {report.sudo.nopasswd
                ? t('value.sudo.nopasswd')
                : report.sudo.available
                  ? t('sudo.passwordRequired')
                  : t('sudo.unavailable')}
            </Row>
            <Row label={t('row.disk')}>
              {report.disk
                ? t('disk.value', {
                    available: gib(report.disk.availableKb, t('unit.gib')),
                    size: gib(report.disk.sizeKb, t('unit.gib')),
                    percent: report.disk.usePercent,
                  })
                : tc('none')}
            </Row>
            <Row label={t('row.memory')}>
              {report.memory
                ? t('memory.value', {
                    available: report.memory.availableMb,
                    total: report.memory.totalMb,
                  })
                : tc('none')}
            </Row>
            <Row label={t('row.tools')}>
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
            <CardTitle>{t('report.runtimes')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Docker">
              {report.runtimes.docker.available
                ? `✓ ${report.runtimes.docker.version ?? ''}`
                : t('runtime.unavailable')}
            </Row>
            <Row label={t('row.compose')}>
              {report.runtimes.docker.composeVersion ?? tc('none')}
            </Row>
            <Row label={t('row.k3s')}>
              {report.runtimes.k3s.available
                ? `✓ ${report.runtimes.k3s.version ?? ''}`
                : t('runtime.unavailable')}
            </Row>
            <Row label={t('row.readyNodes')}>
              {report.runtimes.k3s.nodes === null
                ? tc('none')
                : `${report.runtimes.k3s.readyNodes ?? 0} / ${report.runtimes.k3s.nodes}`}
            </Row>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('report.checks.title')}</CardTitle>
          <CardDescription>{t('report.checks.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('column.check')}</TableHead>
                <TableHead>{tc('column.status')}</TableHead>
                <TableHead>{tc('column.duration')}</TableHead>
                <TableHead>{tc('column.detail')}</TableHead>
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
                  <TableCell className="font-mono text-xs text-text-2 tabular-nums">
                    {check.durationMs} ms
                  </TableCell>
                  <TableCell className="font-mono text-xs text-text-3">
                    {check.error ?? check.detail ?? tc('none')}
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
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-2 last:border-0">
      <span className="text-xs text-text-2">{label}</span>
      <span className="font-mono text-xs text-text">{children}</span>
    </div>
  );
}
