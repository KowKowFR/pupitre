'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pause, Play, Search } from 'lucide-react';
import type { AppLogLine, AppStatus, ServiceState, ServiceStatus } from '@pupitre/core';
import { Led, Readout, ReadoutBar, type Tone } from '@/components/instrument';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { HealthStatus } from '../apps-table';

/** Un service tel que l'AppSpec figée du déploiement le déclare. */
export type ConsoleService = {
  name: string;
  /** Nom de l'image, quand la spec le fixe. `null` si elle est construite. */
  image: string | null;
  built: boolean;
  port: number;
  exposed: boolean;
  dependsOn: string[];
  replicas: number;
  cpuMilli: number | null;
  memoryMi: number | null;
  probePath: string;
  probeIntervalSec: number;
  probeRetries: number;
};

export type ConsoleApp = {
  id: string;
  applicationId: string;
  applicationSlug: string;
  targetId: string;
  targetName: string;
  targetHost: string;
  runtime: string;
  version: number;
  specVersion: string | null;
  url: string | null;
  publishedPort: number | null;
  healthStatus: HealthStatus;
  lastHealthAt: string | null;
  onlineSince: string | null;
  services: ConsoleService[];
  uptime24h: number | null;
  uptimeSamples: number;
  restored: boolean;
};

/** Au-delà, les lignes les plus anciennes sont oubliées : un flux n'a pas de fin. */
const MAX_LINES = 2_000;

type Connection = 'connecting' | 'live' | 'closed' | 'error';

type ExportFormat = 'text' | 'jsonl';

/** Une ligne reçue, numérotée à l'arrivée. Voir `freeze` plus bas. */
type BufferedLine = AppLogLine & { seq: number };

const HEALTH_LABEL: Record<HealthStatus, string> = {
  healthy: 'en marche',
  unhealthy: 'répond mal',
  unreachable: 'injoignable',
  unknown: 'état inconnu',
};

const HEALTH_TONE: Record<HealthStatus, Tone> = {
  healthy: 'ok',
  unhealthy: 'warn',
  unreachable: 'danger',
  unknown: 'idle',
};

/** Le vocabulaire de l'écran des charges, à la lettre : un seul état, un seul mot. */
const STATE_LABEL: Record<ServiceState, string> = {
  running: 'en marche',
  restarting: 'redémarre',
  exited: 'arrêté',
  paused: 'en pause',
  created: 'créé',
  unknown: 'inconnu',
};

const SERVICE_HEALTH_LABEL: Record<ServiceStatus['health'], string | null> = {
  healthy: 'sonde au vert',
  unhealthy: 'sonde au rouge',
  starting: 'sonde en attente',
  none: null,
};

export function AppConsole({ app, context }: { app: ConsoleApp; context?: ReactNode }) {
  const router = useRouter();
  const [lines, setLines] = useState<BufferedLine[]>([]);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [notice, setNotice] = useState<string | null>(null);
  const [service, setService] = useState<string>('');
  const [query, setQuery] = useState<string>('');
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [freeze, setFreeze] = useState<number | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('text');

  const logRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const retryRef = useRef<NodeJS.Timeout | null>(null);
  const attemptRef = useRef(0);
  const connectRef = useRef<(() => void) | null>(null);
  const seqRef = useRef(0);
  /** Arrêts de flux rapprochés, pour espacer les réouvertures. Voir plus bas. */
  const stopsRef = useRef(0);
  const lastStopRef = useRef(0);

  const now = useNow();

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
      const fresh = JSON.parse((event as MessageEvent<string>).data) as AppStatus;
      // Le relevé retenu par la route et le relevé frais du worker peuvent se
      // croiser à l'ouverture : on ne recule jamais dans le temps.
      setStatus((current) => (current && current.checkedAt > fresh.checkedAt ? current : fresh));
    });

    source.addEventListener('log', (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as AppLogLine;
      seqRef.current += 1;
      const line: BufferedLine = { ...payload, seq: seqRef.current };
      setLines((current) => {
        const next = [...current, line];
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
        // Le redémarrage resonde la santé et l'écrit en base : ce qui a été
        // rendu côté serveur — la santé, l'heure de la dernière sonde — vient
        // de vieillir d'un coup. On le redemande plutôt que de l'afficher faux.
        if (payload.detail?.startsWith('terminé')) router.refresh();
        return;
      }

      if (payload.action === 'stream.stopped') {
        /**
         * Le worker a rendu la main — plafond de durée atteint, le plus
         * souvent, après trente minutes de flux.
         *
         * Il faut **refermer cette connexion-ci** pour en rouvrir une autre :
         * la route n'enfile un job que lorsqu'un client se branche, et celle-ci
         * reste techniquement ouverte alors que plus personne n'alimente le
         * canal. Sans cela, un écran laissé ouvert la nuit se tait à la
         * trentième minute, avec pour seul indice un discret « reconnexion… »
         * qui ne mène nulle part.
         *
         * Le délai croît si les arrêts s'enchaînent : un flux qui se referme
         * aussitôt ouvert ne doit pas faire ouvrir une session SSH par seconde
         * sur la machine cible.
         */
        setConnection('error');
        source.close();
        sourceRef.current = null;

        const since = Date.now() - lastStopRef.current;
        stopsRef.current = since < 30_000 ? stopsRef.current + 1 : 1;
        lastStopRef.current = Date.now();

        const delay = Math.min(1000 * 2 ** (stopsRef.current - 1), 30_000);
        retryRef.current = setTimeout(() => connectRef.current?.(), delay);
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
    if (!autoScroll || freeze !== null) return;
    const element = logRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines, autoScroll, freeze]);

  /**
   * L'inventaire : ce que la spec déclare, croisé avec ce que la machine
   * rapporte.
   *
   * Les deux listes sont nécessaires et ne disent pas la même chose. La spec
   * seule ne saurait pas qu'un conteneur est sorti ; le relevé seul ne saurait
   * pas qu'un service **manque**. C'est ce croisement qui rend visible le cas
   * le plus grave — un service déclaré que le runtime ne rapporte pas — au lieu
   * de le laisser s'effacer de la liste.
   */
  const rows = useMemo(() => {
    const reported = new Map((status?.services ?? []).map((row) => [row.name, row]));
    const declared = app.services.map((spec) => ({
      name: spec.name,
      spec,
      live: reported.get(spec.name) ?? null,
    }));
    const extra = (status?.services ?? [])
      .filter((row) => !app.services.some((spec) => spec.name === row.name))
      .map((row) => ({ name: row.name, spec: null, live: row }));
    return [...declared, ...extra];
  }, [app.services, status]);

  const running = rows.filter((row) => row.live?.state === 'running').length;
  const total = rows.length;

  /** Les services proposés au filtre : déclarés ou rapportés, sans doublon. */
  const services = rows.map((row) => row.name);

  const flagged = useMemo(() => lines.filter((line) => levelOf(line.line) !== null), [lines]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return lines.filter((line) => {
      if (freeze !== null && line.seq > freeze) return false;
      if (service && line.service !== service) return false;
      if (onlyFlagged && levelOf(line.line) === null) return false;
      if (needle && !line.line.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [lines, freeze, service, onlyFlagged, query]);

  const held = freeze === null ? 0 : lines.filter((line) => line.seq > freeze).length;
  const filtering = Boolean(service || onlyFlagged || query.trim());

  const statusAge = status && now !== null ? age(now, status.checkedAt) : null;

  return (
    <div className="flex flex-col gap-6">
      {notice ? <Alert>{notice}</Alert> : null}

      {/*
        L'adresse tient sur une ligne et n'a jamais mérité une carte : au-dessus
        des relevés, elle se lit d'un coup avec le reste de l'identité.
      */}
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-xs">
        {app.url ? (
          <a
            href={app.url}
            target="_blank"
            rel="noreferrer"
            className="text-accent truncate underline-offset-4 hover:underline"
          >
            {app.url}
          </a>
        ) : (
          <span className="text-text-3">aucune URL publiée</span>
        )}
        <span className="text-text-3 truncate">
          {app.targetName} · {app.targetHost}
          {app.publishedPort ? ` · port ${app.publishedPort}` : ''} · {app.runtime}
        </span>
      </div>

      <ReadoutBar>
        <Readout
          label="Conteneurs en marche"
          value={status === null ? '—' : running}
          unit={status === null ? undefined : `/ ${total}`}
          tone={
            status === null ? 'idle' : total === 0 ? 'danger' : running === total ? 'ok' : 'danger'
          }
          hint={
            status === null
              ? connection === 'live'
                ? 'premier relevé en attente…'
                : connection === 'connecting'
                  ? 'ouverture du flux…'
                  : 'flux interrompu'
              : statusAge
                ? `relevé il y a ${statusAge}`
                : 'relevé à l’instant'
          }
        />
        <Readout
          label="En ligne depuis"
          value={sinceValue(now, app.onlineSince)}
          unit={sinceUnit(now, app.onlineSince)}
          tone={app.restored ? 'warn' : 'idle'}
          hint={
            app.restored ? 'version restaurée après un retour arrière' : `version #${app.version}`
          }
        />
        <Readout
          label="Disponibilité 24 h"
          value={app.uptime24h === null ? '—' : (app.uptime24h * 100).toFixed(1).replace('.', ',')}
          unit={app.uptime24h === null ? undefined : '%'}
          tone={app.uptime24h === null ? 'idle' : app.uptime24h >= 0.99 ? 'ok' : 'warn'}
          hint={
            app.uptime24h === null
              ? 'aucune sonde de site'
              : `${app.uptimeSamples} mesure${app.uptimeSamples > 1 ? 's' : ''}`
          }
        />
        {/*
          Compté sur le tampon, donc sur ce qui a défilé depuis l'ouverture de
          la page — jamais sur l'histoire de l'application, qui n'est nulle part.
          Le libellé dit « signalées » et pas « erreurs » : c'est une heuristique
          sur le texte, elle n'a pas à se faire passer pour un analyseur.
        */}
        <Readout
          label="Lignes signalées"
          value={flagged.length}
          unit={lines.length > 0 ? `/ ${lines.length}` : undefined}
          tone={flagged.length === 0 ? 'idle' : 'warn'}
          hint={
            lines.length === 0
              ? 'rien reçu depuis l’ouverture'
              : 'un mot d’erreur ou d’avertissement'
          }
        />
      </ReadoutBar>

      {/*
        Deux colonnes, et le placement est explicite pour une raison : en
        dessous de 1280 px la grille s'effondre en une seule colonne, et l'ordre
        du source devient l'ordre de lecture. Il est donc écrit dans le bon
        ordre — l'inventaire, puis les logs, puis le contexte — plutôt que de
        reléguer les logs sous quatre panneaux de contexte sur un portable.

        Le panneau de logs occupe les deux rangées : c'est ce qui fait que les
        deux colonnes finissent à la même hauteur au lieu de laisser l'une des
        deux dans le vide, quelle que soit celle qui est la plus longue.
      */}
      <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-6 xl:col-start-1 xl:row-start-1">
          <section className="border-border bg-card shadow-xs min-w-0 rounded-lg border">
            {/*
              Deux verdicts distincts, et il faut qu'ils le restent : en tête,
              ce que **le panel** a conclu de sa dernière sonde ; en pied, l'âge
              du relevé que **la machine** vient de donner. Les mélanger ferait
              croire qu'une sonde vieille de dix minutes décrit l'instant.
            */}
            <div className="border-border flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b px-5 py-3.5">
              <h2 className="text-text text-[0.9375rem] font-semibold">Services</h2>
              <span className="text-text-2 flex items-center gap-1.5 text-xs">
                <Led tone={HEALTH_TONE[app.healthStatus]} />
                {HEALTH_LABEL[app.healthStatus]}
                <span className="text-text-3">
                  {!app.lastHealthAt
                    ? '· jamais sondée'
                    : now === null
                      ? ''
                      : `· sondée il y a ${age(now, app.lastHealthAt)}`}
                </span>
              </span>
            </div>

            {/*
              Trois situations, trois phrases — les confondre était le défaut de
              cet écran : « pas encore de relevé » n'est pas « la cible ne
              rapporte rien », et l'écran ne doit jamais affirmer le second quand
              il est dans le premier.
            */}
            {rows.length === 0 ? (
              <p className="text-text-3 px-5 py-3.5 text-[0.8125rem]">
                {status === null
                  ? connection === 'live'
                    ? 'Premier relevé en attente — la machine est en train de répondre.'
                    : 'En attente du flux…'
                  : 'La cible ne rapporte aucun conteneur pour ce projet, et la spec n’en déclare aucun.'}
              </p>
            ) : (
              <ul className="divide-border divide-y">
                {rows.map((row) => (
                  <ServiceRow
                    key={row.name}
                    name={row.name}
                    spec={row.spec}
                    live={row.live}
                    awaited={status === null}
                  />
                ))}
              </ul>
            )}

            <div className="border-border text-text-3 border-t px-5 py-2 text-[0.6875rem]">
              {status === null
                ? connection === 'closed' || connection === 'error'
                  ? 'aucun relevé — le flux est interrompu'
                  : 'premier relevé en attente…'
                : `relevé de la machine ${statusAge ? `il y a ${statusAge}` : 'à l’instant'}, renouvelé tant que cette page reste ouverte`}
            </div>
          </section>
        </div>

        <section className="border-border bg-card shadow-xs flex min-h-0 min-w-0 flex-col self-stretch rounded-lg border xl:col-start-2 xl:row-span-2 xl:row-start-1">
          <div className="border-border flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b px-5 py-3.5">
            <h2 className="text-text text-[0.9375rem] font-semibold">Logs applicatifs</h2>
            <span className="text-text-3 text-xs">
              {filtering
                ? `${visible.length} sur ${lines.length} ligne${lines.length > 1 ? 's' : ''}`
                : `${lines.length} ligne${lines.length > 1 ? 's' : ''}`}
              {flagged.length > 0
                ? ` · ${flagged.length} signalée${flagged.length > 1 ? 's' : ''}`
                : ''}{' '}
              · <ConnectionLabel state={connection} />
            </span>
          </div>

          {/* Deux rangées : ce qui restreint ce qu'on lit, puis ce qui commande le flux. */}
          <div className="border-border flex flex-wrap items-center gap-2 border-b px-5 py-2.5">
            <label className="relative min-w-0 flex-1">
              <Search
                className="text-text-3 pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
                aria-hidden
              />
              <Input
                className="h-8 pl-8 font-mono text-xs"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="filtrer les lignes reçues…"
                aria-label="Filtrer les lignes reçues"
              />
            </label>

            {services.length > 1 ? (
              <Select
                className="h-8 w-40"
                value={service}
                onChange={(event) => setService(event.target.value)}
                aria-label="Filtrer par service"
              >
                <option value="">tous les services</option>
                {services.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            ) : null}

            <Toggle
              active={onlyFlagged}
              onChange={setOnlyFlagged}
              label={`signalées${flagged.length > 0 ? ` (${flagged.length})` : ''}`}
              title="Ne garder que les lignes où figure un mot d’erreur ou d’avertissement. C’est une heuristique sur le texte, pas une analyse du format."
            />
          </div>

          <div className="border-border flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-5 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={freeze === null ? 'outline' : 'secondary'}
                onClick={() => setFreeze((current) => (current === null ? seqRef.current : null))}
                title="Le flux continue d’arriver pendant la pause : aucune ligne n’est perdue, elles sont seulement retenues."
              >
                {freeze === null ? (
                  <>
                    <Pause className="size-3.5" /> Figer
                  </>
                ) : (
                  <>
                    <Play className="size-3.5" /> Reprendre
                  </>
                )}
              </Button>
              {freeze !== null ? (
                <span className="text-warn-text text-[0.6875rem]">
                  {held === 0
                    ? 'affichage figé — aucune ligne depuis'
                    : `affichage figé — ${held} ligne${held > 1 ? 's' : ''} retenue${held > 1 ? 's' : ''}`}
                </span>
              ) : (
                <Toggle active={autoScroll} onChange={setAutoScroll} label="défilement auto" />
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
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
                onClick={() =>
                  downloadBuffer(
                    app,
                    visible,
                    { service, query: query.trim(), onlyFlagged },
                    exportFormat,
                  )
                }
              >
                {visible.length === 0
                  ? 'Rien à exporter'
                  : `Exporter ${visible.length} ligne${visible.length > 1 ? 's' : ''}`}
              </Button>
            </div>
          </div>

          <div
            ref={logRef}
            onScroll={(event) => {
              const element = event.currentTarget;
              setAutoScroll(element.scrollHeight - element.scrollTop - element.clientHeight < 40);
            }}
            /*
              Le terminal prend ce qui reste de la colonne : trente-quatre rem
              au minimum, davantage quand le contexte de gauche est plus long.
              C'est la hauteur de lecture qui commande, pas une valeur fixe.
            */
            className="bg-term-bg text-term-fg min-h-[34rem] flex-1 overflow-y-auto rounded-b-lg px-4 py-3 font-mono text-[0.6875rem] leading-[1.65]"
          >
            {visible.length === 0 ? (
              <p className="text-term-dim">
                {lines.length > 0
                  ? 'Aucune ligne du tampon ne passe les filtres.'
                  : connection === 'live'
                    ? 'Aucune ligne pour l’instant — l’application est silencieuse.'
                    : 'Ouverture du flux…'}
              </p>
            ) : (
              visible.map((line) => {
                const level = levelOf(line.line);
                return (
                  <div
                    key={line.seq}
                    className={cn(
                      'flex gap-3 break-words whitespace-pre-wrap',
                      level === 'error' && 'text-term-err',
                      level === 'warn' && 'text-warn-text',
                    )}
                  >
                    <span className="text-term-dim shrink-0 tabular-nums select-none">
                      {line.ts.slice(11, 19)}
                    </span>
                    {line.service ? (
                      <span className="text-term-dim w-24 shrink-0 truncate select-none">
                        {line.service}
                      </span>
                    ) : null}
                    <span className="min-w-0">{line.line}</span>
                  </div>
                );
              })
            )}
          </div>
        </section>

        <div className="flex min-w-0 flex-col gap-6 xl:col-start-1 xl:row-start-2">{context}</div>
      </div>
    </div>
  );
}

/**
 * Une ligne de service : ce qu'on a demandé, et ce que la machine en a fait.
 *
 * L'état vient du runtime ; la spec fournit ce que le runtime ne dit pas — les
 * dépendances, les ressources demandées, la sonde déclarée. Un service déclaré
 * mais absent du relevé n'est pas silencieux : c'est la ligne la plus rouge de
 * l'écran.
 */
function ServiceRow({
  name,
  spec,
  live,
  awaited,
}: {
  name: string;
  spec: ConsoleService | null;
  live: ServiceStatus | null;
  awaited: boolean;
}) {
  const tone: Tone = live
    ? live.state === 'running'
      ? live.health === 'unhealthy'
        ? 'danger'
        : live.health === 'starting'
          ? 'warn'
          : 'ok'
      : live.state === 'restarting' || live.state === 'created' || live.state === 'paused'
        ? 'warn'
        : live.state === 'exited'
          ? 'danger'
          : 'idle'
    : awaited
      ? 'idle'
      : 'danger';

  const health = live ? SERVICE_HEALTH_LABEL[live.health] : null;
  const image =
    live?.image ?? spec?.image ?? (spec?.built ? 'image construite sur la cible' : null);
  const ports = live?.ports.length ? live.ports.join(', ') : spec ? `port ${spec.port}` : null;

  return (
    <li className="flex flex-col gap-1 px-5 py-3">
      <div className="flex items-center gap-2">
        <Led tone={tone} pulse={live?.state === 'restarting'} />
        <span className="text-text min-w-0 flex-1 truncate font-mono text-xs">{name}</span>
        {spec?.exposed ? <span className="text-text-3 text-[0.6875rem]">exposé</span> : null}
        <span
          className={cn(
            'shrink-0 text-[0.6875rem]',
            tone === 'danger'
              ? 'text-danger-text'
              : tone === 'warn'
                ? 'text-warn-text'
                : 'text-text-2',
          )}
        >
          {live
            ? STATE_LABEL[live.state]
            : awaited
              ? 'relevé attendu'
              : 'non rapporté par la cible'}
        </span>
      </div>

      {/*
        Rien n'est coupé ici : dans une colonne de 22 rem, un `truncate` mangeait
        « Up 44 hours (healthy) » — c'est-à-dire la réponse à « depuis quand ».
        Le texte passe donc à la ligne, et seul le nom de l'image, qui peut être
        arbitrairement long, casse au caractère près.
      */}
      <div className="text-text-3 pl-[1.125rem] font-mono text-[0.6875rem] break-all">
        {[image, ports].filter(Boolean).join(' · ') || '—'}
      </div>

      <div className="text-text-3 pl-[1.125rem] text-[0.6875rem]">
        {[
          live?.since,
          health,
          spec && spec.dependsOn.length > 0 ? `après ${spec.dependsOn.join(', ')}` : null,
          spec?.replicas && spec.replicas > 1 ? `${spec.replicas} répliques` : null,
          spec?.cpuMilli || spec?.memoryMi
            ? `demandé ${spec.cpuMilli ?? '—'} mCPU · ${spec.memoryMi ?? '—'} Mio`
            : null,
          // Ce que la sonde interroge, tel que la spec le déclare — c'est cette
          // requête-là qu'on voit repasser dans les logs à intervalle régulier.
          spec
            ? `sonde GET ${spec.probePath} toutes les ${spec.probeIntervalSec} s, ${spec.probeRetries} essais`
            : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </div>
    </li>
  );
}

/**
 * Interrupteur de barre d'outils : un vrai `input` habillé, comme partout
 * ailleurs dans le produit — il n'y a pas de primitive `Switch`, et une case à
 * cocher garde le clavier et les lecteurs d'écran pour rien.
 */
function Toggle({
  active,
  onChange,
  label,
  title,
}: {
  active: boolean;
  onChange: (value: boolean) => void;
  label: string;
  title?: string;
}) {
  return (
    <label
      title={title}
      className={cn(
        'border-border flex shrink-0 cursor-pointer items-center gap-1.5 rounded-sm border px-2 py-1 text-[0.6875rem]',
        active ? 'border-accent-line bg-accent-soft/60 text-accent' : 'text-text-2',
      )}
    >
      <input
        type="checkbox"
        className="sr-only"
        checked={active}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span
        aria-hidden
        className={cn('size-1.5 rounded-full', active ? 'bg-accent' : 'bg-text-3/50')}
      />
      {label}
    </label>
  );
}

/**
 * Niveau d'une ligne, **par heuristique assumée**.
 *
 * Écrire un analyseur de format serait une promesse intenable : une même
 * application mêle du JSON, du texte libre et des logs d'accès, et chaque image
 * a ses conventions. On cherche donc un mot, rien de plus, et l'interface le
 * dit — « signalées », pas « erreurs ». Le mot doit être isolé : `errors` dans
 * une URL ne teinte pas la ligne, `ERROR` en début de ligne oui.
 */
function levelOf(line: string): 'error' | 'warn' | null {
  if (/\b(error|erreur|fatal|panic|critical|exception|failed|échec)\b/i.test(line)) return 'error';
  if (/\b(warn|warning|avertissement|deprecated)\b/i.test(line)) return 'warn';
  return null;
}

/**
 * Horloge de l'écran, réveillée une fois par seconde.
 *
 * `null` avant le montage : un « il y a 12 s » calculé sur le serveur serait
 * faux à l'affichage et provoquerait une divergence d'hydratation. Le premier
 * rendu ne dit donc pas d'âge, le second le dit et le tient à jour.
 */
function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    // Le premier relevé passe par le planificateur plutôt que par le corps de
    // l'effet : une écriture d'état synchrone y déclenche un rendu en cascade.
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);
  return now;
}

function age(now: number, iso: string): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 86400)} j`;
}

/** Le nombre et son unité séparés : un relevé chiffré ne mélange pas les deux. */
function sinceValue(now: number | null, iso: string | null): string | number {
  if (!iso || now === null) return '—';
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 3600) return Math.floor(seconds / 60);
  if (seconds < 86400) return Math.floor(seconds / 3600);
  return Math.floor(seconds / 86400);
}

function sinceUnit(now: number | null, iso: string | null): string | undefined {
  if (!iso || now === null) return undefined;
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 3600) return 'min';
  if (seconds < 86400) return 'h';
  return seconds < 172800 ? 'jour' : 'jours';
}

/**
 * Export du tampon affiché.
 *
 * Un flux applicatif n'a pas de fin et n'est pas persisté : « exporter les
 * logs » n'a de sens que pour ce que le navigateur a déjà reçu. Demander au
 * worker un `logs --tail N` donnerait un autre fichier — plus large, mais qui
 * ne correspondrait pas à ce que l'écran montre, et qui ouvrirait une seconde
 * session SSH depuis une requête HTTP. On exporte donc exactement ce qui est à
 * l'écran, filtres compris, et l'en-tête du fichier les énumère.
 *
 * Le `Blob` est ici le seul moyen : la donnée n'existe que dans cette page.
 * L'URL d'objet est révoquée juste après — sans quoi chaque export garderait le
 * contenu en mémoire jusqu'au rechargement de l'onglet.
 */
function downloadBuffer(
  app: ConsoleApp,
  lines: BufferedLine[],
  filters: { service: string; query: string; onlyFlagged: boolean },
  format: ExportFormat,
): void {
  const content =
    format === 'jsonl'
      ? // Le numéro d'ordre est un outil interne à la pause : il n'a rien à
        // faire dans un fichier exporté.
        lines
          .map((line) => JSON.stringify({ ts: line.ts, service: line.service, line: line.line }))
          .join('\n') + '\n'
      : bufferHeader(app, lines.length, filters) +
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
function bufferHeader(
  app: ConsoleApp,
  count: number,
  filters: { service: string; query: string; onlyFlagged: boolean },
): string {
  return [
    `# Logs applicatifs — ${app.applicationSlug} v${app.version}`,
    `# Cible : ${app.targetName} (${app.targetHost}) · ${app.runtime}`,
    `# ${count} ligne(s) : le tampon affiché par le navigateur, rien de plus.`,
    `# Ce flux n'est pas persisté — aucune ligne antérieure à l'ouverture de cette page`,
    `# n'y figure, et seules les ${MAX_LINES} dernières lignes reçues sont conservées.`,
    ...(filters.service ? [`# Filtre : seul le service « ${filters.service} » est exporté.`] : []),
    ...(filters.query ? [`# Filtre : seules les lignes contenant « ${filters.query} ».`] : []),
    ...(filters.onlyFlagged
      ? ["# Filtre : seules les lignes où figure un mot d'erreur ou d'avertissement."]
      : []),
    `# Exporté le ${new Date().toISOString()}`,
    '#',
    '',
  ].join('\n');
}

function ConnectionLabel({ state }: { state: Connection }) {
  const label = {
    connecting: 'ouverture du flux…',
    live: 'flux en direct',
    closed: 'flux fermé',
    error: 'reconnexion…',
  }[state];

  return <span className={cn(state === 'error' && 'text-warn-text')}>{label}</span>;
}
