'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Download, Pause, Play, Search } from 'lucide-react';
import type { AppLogLine, AppStatus, ServiceState, ServiceStatus, Translate } from '@pupitre/core';
import { Led, type Tone } from '@/components/instrument';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Tooltip } from '@/components/ui/tooltip';
import { useT } from '@/i18n/client';
import { appConsole } from '@/i18n/messages/console';
import { servers } from '@/i18n/messages/servers';
import { cn } from '@/lib/utils';
import { HealthDot, type HealthStatus } from '../apps-table';

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
  applicationSlug: string;
  targetName: string;
  targetHost: string;
  runtime: string;
  version: number;
  healthStatus: HealthStatus;
  lastHealthAt: string | null;
  services: ConsoleService[];
};

/** Au-delà, les lignes les plus anciennes sont oubliées : un flux n'a pas de fin. */
const MAX_LINES = 2_000;

type Connection = 'connecting' | 'live' | 'closed' | 'error';

type ExportFormat = 'text' | 'jsonl';

/** Une ligne reçue, numérotée à l'arrivée. Voir `freeze` plus bas. */
type BufferedLine = AppLogLine & { seq: number };

type T = Translate<typeof appConsole.fr>;
type TSince = Translate<typeof servers.fr>;

/** Le vocabulaire de l'écran des charges, à la lettre : un seul état, un seul mot. */
const STATE_KEY: Record<ServiceState, keyof typeof appConsole.fr> = {
  running: 'state.running',
  restarting: 'state.restarting',
  exited: 'state.exited',
  paused: 'state.paused',
  created: 'state.created',
  unknown: 'state.unknown',
};

const SERVICE_HEALTH_KEY: Record<ServiceStatus['health'], keyof typeof appConsole.fr | null> = {
  healthy: 'service.health.healthy',
  unhealthy: 'service.health.unhealthy',
  starting: 'service.health.starting',
  none: null,
};

const CONNECTION_KEY: Record<Connection, keyof typeof appConsole.fr> = {
  connecting: 'connection.connecting',
  live: 'connection.live',
  closed: 'connection.closed',
  error: 'connection.error',
};

/**
 * La console : l'inventaire des services à gauche, le terminal à droite, et le
 * contexte tiré de la base sous l'inventaire.
 *
 * Deux colonnes, et le placement est explicite pour une raison : en dessous de
 * 1280 px la grille s'effondre en une seule colonne, et l'ordre du source
 * devient l'ordre de lecture. Il est donc écrit dans le bon ordre —
 * l'inventaire, puis les logs, puis le contexte — plutôt que de reléguer les
 * logs sous trois cartes de contexte sur un portable.
 */
export function AppConsole({ app, context }: { app: ConsoleApp; context?: ReactNode }) {
  const t = useT(appConsole);
  const tSince = useT(servers);
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
        done?: boolean;
      };

      if (payload.action === 'restart') {
        setNotice(payload.detail ?? '');
        // Le redémarrage resonde la santé et l'écrit en base : ce qui a été
        // rendu côté serveur — la santé, l'heure de la dernière sonde — vient
        // de vieillir d'un coup. On le redemande plutôt que de l'afficher faux.
        if (payload.done) router.refresh();
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

  const statusAge =
    status && now !== null ? t('age.ago', { age: age(now, status.checkedAt, tSince) }) : null;

  // L'en-tête du terminal : combien, combien de signalées, et l'état du flux —
  // ou, pendant une pause, combien de lignes attendent.
  const headline = [
    filtering
      ? t('logs.countFiltered', { visible: visible.length, count: lines.length })
      : t('logs.count', { count: lines.length }),
    flagged.length > 0 ? t('logs.flagged', { count: flagged.length }) : null,
    freeze !== null
      ? held === 0
        ? t('logs.frozen.none')
        : t('logs.frozen', { count: held })
      : t(CONNECTION_KEY[connection]),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="grid grid-cols-1 min-w-0 items-start gap-5 xl:grid-cols-[352px_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-4 xl:col-start-1 xl:row-start-1">
        {notice !== null ? (
          <Alert variant="info">
            {t('notice.restart', { detail: notice || t('notice.restart.pending') })}
          </Alert>
        ) : null}

        <section className="card overflow-hidden">
          {/*
            Deux verdicts distincts, et il faut qu'ils le restent : en tête, ce
            que **le panel** a conclu de sa dernière sonde ; en pied, l'âge du
            relevé que **la machine** vient de donner. Les mélanger ferait
            croire qu'une sonde vieille de dix minutes décrit l'instant.
          */}
          <div className="card-h">
            <h2>{t('services.title')}</h2>
            <span className="ml-auto">
              <HealthDot
                health={app.healthStatus}
                meta={
                  !app.lastHealthAt
                    ? t('services.neverProbed')
                    : now === null
                      ? undefined
                      : t('services.probed', { age: age(now, app.lastHealthAt, tSince) })
                }
              />
            </span>
          </div>

          {/*
            Trois situations, trois phrases — les confondre était le défaut de
            cet écran : « pas encore de relevé » n'est pas « la cible ne
            rapporte rien », et l'écran ne doit jamais affirmer le second quand
            il est dans le premier.
          */}
          {rows.length === 0 ? (
            <p className="t-sm px-4 py-3 text-text-3">
              {status === null
                ? connection === 'live'
                  ? t('services.awaiting')
                  : t('services.waiting')
                : t('services.none')}
            </p>
          ) : (
            <ul className="list">
              {rows.map((row) => (
                <ServiceRow
                  key={row.name}
                  name={row.name}
                  spec={row.spec}
                  live={row.live}
                  awaited={status === null}
                  t={t}
                />
              ))}
            </ul>
          )}

          <div className="pager flex-col items-start gap-0.5">
            {status !== null ? (
              <span className="font-medium text-text-2">
                {t('services.running', { running, count: rows.length })}
              </span>
            ) : null}
            <span>
              {status === null
                ? connection === 'closed' || connection === 'error'
                  ? t('services.footer.interrupted')
                  : t('services.footer.pending')
                : t('services.footer.read', { age: statusAge ?? t('age.now') })}
            </span>
          </div>
        </section>
      </div>

      {/*
        Le terminal est posé en absolu dans sa cellule : c'est la colonne de
        gauche qui donne la hauteur de la rangée, et un tampon de deux mille
        lignes défile dedans au lieu d'allonger la page.
      */}
      <div className="relative min-h-[34rem] min-w-0 xl:col-start-2 xl:row-span-2 xl:row-start-1 xl:self-stretch">
        <section className="term absolute inset-0" aria-label={t('logs.title')}>
          <div className="term-h">
            <span className="flex shrink-0 items-center gap-2">
              <Led
                tone={connection === 'live' ? 'ok' : connection === 'error' ? 'warn' : 'idle'}
                pulse={connection === 'live' && freeze === null}
              />
              <span className="font-semibold text-term-fg">{t('logs.title')}</span>
            </span>
            <span
              className={cn(
                'mono min-w-0 truncate text-[11.5px]',
                (freeze !== null || connection === 'error') && 'text-term-warn',
              )}
            >
              {headline}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              <Tooltip content={t('logs.pause.tip')} wide>
                <Button
                  size="sm"
                  variant="ghost"
                  className="btn-term"
                  aria-pressed={freeze !== null}
                  onClick={() => setFreeze((current) => (current === null ? seqRef.current : null))}
                >
                  {freeze === null ? <Pause aria-hidden /> : <Play aria-hidden />}
                  {freeze === null ? t('logs.pause') : t('logs.resume')}
                </Button>
              </Tooltip>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="ghost" className="btn-term">
                    <Download aria-hidden />
                    {t('logs.export')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-72">
                  {visible.length === 0 ? (
                    <DropdownMenuLabel className="t-sm font-normal text-text-2">
                      {t('logs.export.empty')}
                    </DropdownMenuLabel>
                  ) : (
                    <>
                      <DropdownMenuItem
                        onSelect={() =>
                          downloadBuffer(
                            app,
                            visible,
                            { service, query: query.trim(), onlyFlagged },
                            'text',
                            t,
                          )
                        }
                      >
                        {t('logs.export.log')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() =>
                          downloadBuffer(
                            app,
                            visible,
                            { service, query: query.trim(), onlyFlagged },
                            'jsonl',
                            t,
                          )
                        }
                      >
                        {t('logs.export.jsonl')}
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="t-cap font-normal text-text-3">
                    {t('logs.export.scope', { max: MAX_LINES })}
                  </DropdownMenuLabel>
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-b border-term-line px-3.5 py-2 font-sans">
            <label className="affix w-full sm:w-[260px]">
              <Search aria-hidden />
              <Input
                className="input-sm"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('logs.filter')}
                aria-label={t('logs.filter.label')}
              />
            </label>

            {services.length > 1 ? (
              <Select
                className="input-sm w-[170px]"
                value={service}
                onChange={(event) => setService(event.target.value)}
                aria-label={t('logs.service.label')}
              >
                <option value="">{t('logs.service.all')}</option>
                {services.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            ) : null}

            <Tooltip content={t('logs.onlyFlagged.tip')} wide>
              <button
                type="button"
                className="chip"
                aria-pressed={onlyFlagged}
                onClick={() => setOnlyFlagged((current) => !current)}
              >
                {t('logs.onlyFlagged')}
                <span className="count">{flagged.length}</span>
              </button>
            </Tooltip>
          </div>

          <div
            ref={logRef}
            className="term-b min-h-0"
            role="log"
            aria-live="off"
            tabIndex={0}
            aria-label={t('logs.title')}
            onScroll={(event) => {
              const element = event.currentTarget;
              setAutoScroll(element.scrollHeight - element.scrollTop - element.clientHeight < 40);
            }}
          >
            {visible.length === 0 ? (
              <p className="px-3.5 text-term-dim">
                {lines.length > 0
                  ? t('logs.empty.filtered')
                  : connection === 'live'
                    ? t('logs.empty.silent')
                    : t('logs.empty.opening')}
              </p>
            ) : (
              visible.map((line) => {
                const level = levelOf(line.line);
                return (
                  <div
                    key={line.seq}
                    className={cn(
                      'ln',
                      level === 'error' && 'is-err',
                      level === 'warn' && 'is-warn',
                    )}
                  >
                    <span className="ts tabular-nums select-none">{line.ts.slice(11, 19)}</span>
                    {line.service ? (
                      <span className="sv max-w-[7rem] truncate select-none">{line.service}</span>
                    ) : null}
                    <span
                      className={cn('min-w-0', level === 'error' && 'e', level === 'warn' && 'w')}
                    >
                      {line.line}
                    </span>
                  </div>
                );
              })
            )}
            {connection === 'live' && freeze === null && !filtering ? (
              <div className="ln" aria-hidden>
                <span className="ts invisible">00:00:00</span>
                <span className="cursor" />
              </div>
            ) : null}
          </div>
        </section>
      </div>

      <div className="flex min-w-0 flex-col gap-4 xl:col-start-1 xl:row-start-2">{context}</div>
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
  t,
}: {
  name: string;
  spec: ConsoleService | null;
  live: ServiceStatus | null;
  awaited: boolean;
  t: T;
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

  const healthKey = live ? SERVICE_HEALTH_KEY[live.health] : null;
  const image = live?.image ?? spec?.image ?? (spec?.built ? t('service.built') : null);
  const ports = live?.ports.length
    ? live.ports.join(', ')
    : spec
      ? t('service.port', { port: spec.port })
      : null;

  return (
    <li className="flex-col !items-stretch gap-0.5">
      <span className="flex items-center gap-2">
        <Led tone={tone} pulse={live?.state === 'restarting'} />
        <span className="mono truncate text-[12.5px] font-semibold text-text">{name}</span>
        {spec?.exposed ? <Badge variant="accent">{t('service.exposed')}</Badge> : null}
        <span
          className={cn(
            't-cap ml-auto shrink-0',
            tone === 'danger' ? 'text-danger-text' : 'text-text-3',
          )}
        >
          {live ? t(STATE_KEY[live.state]) : awaited ? t('state.awaited') : t('state.missing')}
        </span>
      </span>

      {/*
        Rien n'est coupé ici : dans une colonne étroite, un `truncate` mangeait
        « Up 44 hours (healthy) » — c'est-à-dire la réponse à « depuis quand ».
        Le texte passe donc à la ligne, et seul le nom de l'image, qui peut être
        arbitrairement long, casse au caractère près.
      */}
      <span className="mono text-[11px] break-all text-text-3">
        {[image, ports].filter(Boolean).join(' · ') || '—'}
      </span>

      <span className="t-cap text-text-3">
        {[
          live?.since,
          healthKey ? t(healthKey) : null,
          spec && spec.dependsOn.length > 0
            ? t('service.after', { services: spec.dependsOn.join(', ') })
            : null,
          spec?.replicas ? t('service.replicas', { count: spec.replicas }) : null,
          spec?.cpuMilli || spec?.memoryMi
            ? t('service.requested', {
                cpu: spec.cpuMilli ?? '—',
                memory: spec.memoryMi ?? '—',
              })
            : null,
          // Ce que la sonde interroge, tel que la spec le déclare — c'est cette
          // requête-là qu'on voit repasser dans les logs à intervalle régulier.
          spec
            ? t('service.probe', {
                path: spec.probePath,
                interval: spec.probeIntervalSec,
                retries: spec.probeRetries,
              })
            : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
    </li>
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
  // i18n-ignore : des mots cherchés dans les logs, pas des libellés d'interface.
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

/** Un âge court — « 12 s », « 3 min », « 4 j » — dans les unités de la supervision. */
function age(now: number, iso: string, t: TSince): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return t('since.seconds', { count: seconds });
  if (seconds < 3600) return t('since.minutes', { count: Math.floor(seconds / 60) });
  if (seconds < 86400) return t('since.hours', { count: Math.floor(seconds / 3600) });
  return t('since.days', { count: Math.floor(seconds / 86400) });
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
  t: T,
): void {
  const content =
    format === 'jsonl'
      ? // Le numéro d'ordre est un outil interne à la pause : il n'a rien à
        // faire dans un fichier exporté.
        lines
          .map((line) => JSON.stringify({ ts: line.ts, service: line.service, line: line.line }))
          .join('\n') + '\n'
      : bufferHeader(app, lines.length, filters, t) +
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
  t: T,
): string {
  return [
    t('export.title', { slug: app.applicationSlug, version: app.version }),
    t('export.target', { name: app.targetName, host: app.targetHost, runtime: app.runtime }),
    t('export.count', { count }),
    t('export.notPersisted'),
    t('export.notPersisted.end', { max: MAX_LINES }),
    ...(filters.service ? [t('export.filter.service', { service: filters.service })] : []),
    ...(filters.query ? [t('export.filter.query', { query: filters.query })] : []),
    ...(filters.onlyFlagged ? [t('export.filter.flagged')] : []),
    t('export.at', { date: new Date().toISOString() }),
    '',
  ]
    .map((line) => `# ${line}`.trimEnd())
    .join('\n')
    .concat('\n');
}
