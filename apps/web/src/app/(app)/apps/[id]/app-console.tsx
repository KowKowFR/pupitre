'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppLogLine, AppStatus, ServiceStatus } from '@tp/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { HealthDot, type HealthStatus } from '../apps-table';

export type ConsoleApp = {
  id: string;
  applicationSlug: string;
  targetName: string;
  targetHost: string;
  runtime: string;
  version: number;
  url: string | null;
  publishedPort: number | null;
  healthStatus: HealthStatus;
  services: string[];
  canRestart: boolean;
};

type ApiError = { error?: { message?: string } };

/** Au-delà, les lignes les plus anciennes sont oubliées : un flux n'a pas de fin. */
const MAX_LINES = 2_000;

type Connection = 'connecting' | 'live' | 'closed' | 'error';

type ExportFormat = 'text' | 'jsonl';

export function AppConsole({ app }: { app: ConsoleApp }) {
  const router = useRouter();
  const [lines, setLines] = useState<AppLogLine[]>([]);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [restarting, setRestarting] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('text');

  const logRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const retryRef = useRef<NodeJS.Timeout | null>(null);
  const attemptRef = useRef(0);
  const connectRef = useRef<(() => void) | null>(null);

  const connect = useCallback(() => {
    sourceRef.current?.close();

    const source = new EventSource(`/api/apps/${app.id}/logs`);
    sourceRef.current = source;

    source.addEventListener('open', () => {
      attemptRef.current = 0;
      setConnection('live');
    });

    source.addEventListener('ready', () => setConnection('live'));

    source.addEventListener('status', (event) => {
      setStatus(JSON.parse((event as MessageEvent<string>).data) as AppStatus);
    });

    source.addEventListener('log', (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as AppLogLine;
      setLines((current) => {
        const next = [...current, payload];
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    });

    source.addEventListener('lifecycle', (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        action: string;
        detail: string | null;
      };

      if (payload.action === 'restart') {
        setNotice(`Redémarrage : ${payload.detail ?? 'en cours'}`);
        if (payload.detail?.startsWith('terminé')) {
          setRestarting(false);
          router.refresh();
        }
        return;
      }

      if (payload.action === 'stream.stopped') {
        // Le worker a coupé — plafond de durée, ou aucun spectateur détecté.
        // On se rebranche : la route relancera un flux.
        setConnection('error');
      }
    });

    source.addEventListener('error', () => {
      if (source.readyState !== EventSource.CLOSED) return;

      setConnection('error');
      source.close();
      sourceRef.current = null;

      attemptRef.current += 1;
      const delay = Math.min(1000 * 2 ** (attemptRef.current - 1), 15_000);
      retryRef.current = setTimeout(() => connectRef.current?.(), delay);
    });
  }, [app.id, router]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    connect();
    return () => {
      if (retryRef.current) clearTimeout(retryRef.current);
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [connect]);

  useEffect(() => {
    if (!autoScroll) return;
    const element = logRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines, autoScroll]);

  async function restart() {
    if (
      !window.confirm(
        `Redémarrer « ${app.applicationSlug} » ?\n\n` +
          "Mêmes images, mêmes volumes, même port. L'application sera brièvement indisponible.",
      )
    ) {
      return;
    }

    setRestarting(true);
    setError(null);
    setNotice('Redémarrage demandé…');

    const response = await fetch(`/api/apps/${app.id}/restart`, { method: 'POST' });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? `Échec (HTTP ${response.status})`);
      setRestarting(false);
      setNotice(null);
    }
  }

  const visible = filter ? lines.filter((line) => line.service === filter) : lines;
  const services = status?.services ?? [];

  return (
    <div className="space-y-6">
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      {notice ? <Alert>{notice}</Alert> : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>État</CardTitle>
              <CardDescription>
                {status
                  ? `Relevé à ${status.checkedAt.slice(11, 19)} UTC`
                  : 'Relevé à l’ouverture du flux…'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <HealthDot health={app.healthStatus} />

              {services.length === 0 ? (
                <p className="text-ink-faint text-xs">
                  {connection === 'live'
                    ? 'Aucun conteneur rapporté par la cible.'
                    : 'En attente du worker…'}
                </p>
              ) : (
                <ul className="space-y-2">
                  {services.map((service) => (
                    <ServiceRow key={service.name} service={service} />
                  ))}
                </ul>
              )}

              {app.canRestart ? (
                <Button
                  className="w-full"
                  size="sm"
                  variant="outline"
                  disabled={restarting}
                  onClick={() => void restart()}
                >
                  {restarting ? 'Redémarrage…' : 'Redémarrer l’application'}
                </Button>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Adresse</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 font-mono text-xs">
              {app.url ? (
                <a href={app.url} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                  {app.url}
                </a>
              ) : (
                <span className="text-ink-faint">aucune URL publiée</span>
              )}
              <div className="text-ink-faint">
                {app.targetName} · {app.targetHost}
                {app.publishedPort ? ` · port ${app.publishedPort}` : ''}
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="min-h-0">
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0">
            <div>
              <CardTitle>Logs applicatifs</CardTitle>
              <CardDescription>
                {visible.length} ligne{visible.length > 1 ? 's' : ''} ·{' '}
                <ConnectionLabel state={connection} />
              </CardDescription>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {services.length > 1 ? (
                <Select
                  className="h-8 w-40"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  aria-label="Filtrer par service"
                >
                  <option value="">tous les services</option>
                  {services.map((service) => (
                    <option key={service.name} value={service.name}>
                      {service.name}
                    </option>
                  ))}
                </Select>
              ) : null}

              <Select
                className="h-8 w-24"
                value={exportFormat}
                onChange={(event) => setExportFormat(event.target.value as ExportFormat)}
                aria-label="Format d’export"
              >
                <option value="text">.log</option>
                <option value="jsonl">.jsonl</option>
              </Select>

              <Button
                size="sm"
                variant="outline"
                disabled={visible.length === 0}
                title={
                  'Ce flux n’est pas persisté : le fichier contient le tampon du navigateur, ' +
                  `soit au plus les ${MAX_LINES} dernières lignes reçues depuis l’ouverture de cette page.`
                }
                onClick={() => downloadBuffer(app, visible, filter, exportFormat)}
              >
                {visible.length === 0
                  ? 'Aucune ligne à exporter'
                  : visible.length === 1
                    ? 'Exporter la ligne affichée'
                    : `Exporter les ${visible.length} lignes affichées`}
              </Button>

              <label className="text-ink-muted flex shrink-0 items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(event) => setAutoScroll(event.target.checked)}
                />
                défilement auto
              </label>
            </div>
          </CardHeader>

          <CardContent>
            <div
              ref={logRef}
              onScroll={(event) => {
                const element = event.currentTarget;
                setAutoScroll(
                  element.scrollHeight - element.scrollTop - element.clientHeight < 40,
                );
              }}
              className="bg-terminal text-terminal-fg h-[30rem] overflow-y-auto rounded-md border p-3 font-mono text-[11px] leading-relaxed"
            >
              {visible.length === 0 ? (
                <p className="text-terminal-dim">
                  {connection === 'live'
                    ? 'Aucune ligne pour l’instant — l’application est silencieuse.'
                    : 'Ouverture du flux…'}
                </p>
              ) : (
                visible.map((line, index) => (
                  <div key={`${line.ts}-${index}`} className="flex gap-2 break-words whitespace-pre-wrap">
                    <span className="text-terminal-dim shrink-0 select-none">
                      {line.ts.slice(11, 19)}
                    </span>
                    {line.service ? (
                      <span className="text-terminal-dim w-24 shrink-0 truncate select-none">
                        {line.service}
                      </span>
                    ) : null}
                    <span className="min-w-0">{line.line}</span>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * Export du tampon affiché.
 *
 * Un flux applicatif n'a pas de fin et n'est pas persisté : « exporter les logs »
 * n'a de sens que pour ce que le navigateur a déjà reçu. Demander au worker un
 * `logs --tail N` donnerait un autre fichier — plus large, mais qui ne
 * correspondrait pas à ce que l'écran montre, et qui ouvrirait une seconde
 * session SSH depuis une requête HTTP. On exporte donc exactement le tampon,
 * et le libellé du bouton comme l'en-tête du fichier le disent.
 *
 * Le `Blob` est ici le seul moyen : la donnée n'existe que dans cette page.
 * L'URL d'objet est révoquée juste après — sans quoi chaque export garderait le
 * contenu en mémoire jusqu'au rechargement de l'onglet.
 */
function downloadBuffer(
  app: ConsoleApp,
  lines: AppLogLine[],
  filter: string,
  format: ExportFormat,
): void {
  const content =
    format === 'jsonl'
      ? lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
      : bufferHeader(app, lines.length, filter) +
        lines
          .map((line) => `${line.ts}  ${(line.service ?? '-').padEnd(14)}  ${line.line}`)
          .join('\n') +
        '\n';

  const blob = new Blob([content], {
    type: format === 'jsonl' ? 'application/x-ndjson' : 'text/plain;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const slug = app.applicationSlug.replace(/[^A-Za-z0-9._-]+/g, '-') || 'application';

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${slug}-v${app.version}-console-${stamp}.${format === 'jsonl' ? 'jsonl' : 'log'}`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  // Différé d'un tour de boucle : révoquer dans la foulée du clic annule le
  // téléchargement sur certains navigateurs.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Dit au lecteur ce que le fichier contient — et surtout ce qu'il ne contient pas. */
function bufferHeader(app: ConsoleApp, count: number, filter: string): string {
  return [
    `# Logs applicatifs — ${app.applicationSlug} v${app.version}`,
    `# Cible : ${app.targetName} (${app.targetHost}) · ${app.runtime}`,
    `# ${count} ligne(s) : le tampon affiché par le navigateur, rien de plus.`,
    `# Ce flux n'est pas persisté — aucune ligne antérieure à l'ouverture de cette page`,
    `# n'y figure, et seules les ${MAX_LINES} dernières lignes reçues sont conservées.`,
    ...(filter ? [`# Filtre actif : seul le service « ${filter} » est exporté.`] : []),
    `# Exporté le ${new Date().toISOString()}`,
    '#',
    '',
  ].join('\n');
}

function ServiceRow({ service }: { service: ServiceStatus }) {
  const variant =
    service.state === 'running' && service.health !== 'unhealthy'
      ? 'ok'
      : service.state === 'restarting' || service.health === 'starting'
        ? 'warn'
        : service.state === 'exited'
          ? 'destructive'
          : 'secondary';

  return (
    <li className="border-line flex items-start justify-between gap-3 border-b pb-2 last:border-0 last:pb-0">
      <div className="min-w-0">
        <div className="font-mono text-xs">{service.name}</div>
        {service.since ? (
          <div className="text-ink-faint truncate text-[11px]">{service.since}</div>
        ) : null}
      </div>
      <Badge variant={variant} className="shrink-0 text-[10px]">
        {service.state}
      </Badge>
    </li>
  );
}

function ConnectionLabel({ state }: { state: Connection }) {
  const label = {
    connecting: 'ouverture du flux…',
    live: 'flux en direct',
    closed: 'flux fermé',
    error: 'reconnexion…',
  }[state];

  return <span className={cn(state === 'error' && 'text-warn')}>{label}</span>;
}
